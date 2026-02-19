import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { MongoClient, ObjectId } from 'mongodb';
import admin from 'firebase-admin';

let cachedClient: MongoClient | null = null;
let cachedDb: any = null;

async function getMongoDb() {
  if (cachedDb) return cachedDb;

  if (!process.env.MONGODB_URI) {
    console.error('[Mongo] MONGODB_URI is missing');
    throw new Error('MONGODB_URI not configured');
  }

  const client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 10000,
    serverSelectionTimeoutMS: 5000,
  });

  await client.connect();
  cachedClient = client;
  cachedDb = client.db('upsc_cron');
  console.log('[Mongo] Connected to database: upsc_cron');
  return cachedDb;
}

// ────────────────────────────────────────────────
// Firebase Admin (for verifying ID tokens)
let firebaseAdmin: admin.app.App | null = null;

function initFirebaseAdmin() {
  if (firebaseAdmin) return firebaseAdmin;

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT missing in env');
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  firebaseAdmin = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key.replace(/\\n/g, '\n'),
    }),
  });

  console.log('[Firebase] Admin SDK initialized');
  return firebaseAdmin;
}

// ────────────────────────────────────────────────
// Google Play Android Publisher client
let androidPublisher: any = null;

try {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT missing');
  }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  const jwtClient = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  androidPublisher = google.androidpublisher({
    version: 'v3',
    auth: jwtClient,
  });

  console.log('[Google Play] Publisher client initialized');
} catch (err: any) {
  console.error('[Google Play] Failed to init publisher client:', err.message);
}

// ────────────────────────────────────────────────
// POST: Google Play real-time developer notifications (Pub/Sub webhook)
export async function POST(req: NextRequest) {
  // Google Pub/Sub requires 200 OK even on error → otherwise retries forever
  if (!androidPublisher) {
    console.error('[webhook] Google Publisher client not ready');
    return NextResponse.json({}, { status: 200 });
  }

  try {
    const body = await req.json();

    if (!body?.message?.data) {
      console.warn('[webhook] Invalid Pub/Sub payload');
      return NextResponse.json({}, { status: 200 });
    }

    const raw = Buffer.from(body.message.data, 'base64').toString('utf-8');
    const payload = JSON.parse(raw);

    const notification = payload.subscriptionNotification;
    if (!notification) {
      console.log('[webhook] Not a subscription notification');
      return NextResponse.json({}, { status: 200 });
    }

    const { purchaseToken, subscriptionId } = notification;

    if (!purchaseToken || !subscriptionId) {
      console.warn('[webhook] Missing purchaseToken or subscriptionId');
      return NextResponse.json({}, { status: 200 });
    }

    console.log(`[webhook] Processing → ${subscriptionId} | token: ${purchaseToken}`);

    // Verify with Google Play
    const { data: purchase } = await androidPublisher.purchases.subscriptions.get({
      packageName: process.env.PACKAGE_NAME || 'com.rajan.cron',
      subscriptionId,
      token: purchaseToken,
    });

    if (!purchase?.expiryTimeMillis) {
      console.error('[webhook] No expiryTimeMillis in purchase data');
      return NextResponse.json({}, { status: 200 });
    }

    const expiryMs = Number(purchase.expiryTimeMillis);
    const isActive = expiryMs > Date.now();

    const db = await getMongoDb();

    await db.collection('subscriptions').updateOne(
      { purchaseToken },
      {
        $set: {
          subscriptionId,
          purchaseToken,
          expiryTimeMillis: expiryMs,
          isActive,
          kind: purchase.kind,
          autoRenewing: purchase.autoRenewing ?? false,
          paymentState: purchase.paymentState,
          orderId: purchase.orderId,
          linkedPurchaseToken: purchase.linkedPurchaseToken,
          countryCode: purchase.countryCode,
          priceCurrencyCode: purchase.priceCurrencyCode,
          priceAmountMicros: purchase.priceAmountMicros,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
          packageName: process.env.PACKAGE_NAME || 'com.rajan.cron',
        },
      },
      { upsert: true }
    );

    console.log(`[webhook] Saved → active: ${isActive}, expires: ${new Date(expiryMs).toISOString()}`);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err: any) {
    console.error('[webhook] Error:', err.message, err.stack?.substring(0, 600));
    return NextResponse.json({}, { status: 200 }); // must return 200
  }
}
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook endpoint ready - use POST for Google Play RTDN',
    timestamp: new Date().toISOString(),
    googleClientReady: !!androidPublisher,
  });
}
