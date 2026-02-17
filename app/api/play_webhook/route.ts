import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { MongoClient } from 'mongodb';

// Global cached MongoDB connection (essential for serverless / Vercel)
let cachedClient: MongoClient | null = null;
let cachedDb: any = null;

async function getMongoDb() {
  if (cachedDb) return cachedDb;

  if (!process.env.MONGODB_URI) {
    console.error('[Mongo] MONGODB_URI is missing in environment variables');
    throw new Error('MONGODB_URI is not configured');
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

// Singleton Google Android Publisher client
let androidPublisher: any = null;

try {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT is missing in environment variables');
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

  console.log('[cold-start] Google Play Publisher client initialized successfully');
} catch (err: any) {
  console.error('[cold-start] Failed to initialize Google Publisher client:', {
    message: err.message,
    stack: err.stack?.substring(0, 600),
  });
}

// ────────────────────────────────────────────────
// Main webhook handler (POST only - Google Pub/Sub)
export async function POST(req: NextRequest) {
  // ALWAYS return 200 OK to acknowledge Pub/Sub message
  // Returning 4xx/5xx triggers infinite redelivery → very expensive

  if (!androidPublisher) {
    console.error('[webhook] Google Publisher client not available');
    return NextResponse.json({}, { status: 200 });
  }

  try {
    const body = await req.json();

    if (!body?.message?.data) {
      console.warn('[webhook] Invalid Pub/Sub format - missing message.data');
      return NextResponse.json({ error: 'Missing message.data' }, { status: 400 });
    }

    // Decode base64 → JSON
    let payload: any;
    try {
      const raw = Buffer.from(body.message.data, 'base64').toString('utf-8');
      payload = JSON.parse(raw);
    } catch (decodeErr: any) {
      console.error('[webhook] Failed to decode/parse Pub/Sub payload:', decodeErr.message);
      return NextResponse.json({}, { status: 200 });
    }

    const notification = payload.subscriptionNotification;
    if (!notification) {
      console.log('[webhook] Not a subscription notification event');
      return NextResponse.json({}, { status: 200 });
    }

    const { purchaseToken, subscriptionId } = notification;

    if (!purchaseToken || !subscriptionId) {
      console.warn('[webhook] Missing purchaseToken or subscriptionId');
      return NextResponse.json({}, { status: 200 });
    }

    console.log(`[webhook] Processing → subscriptionId: ${subscriptionId} | purchaseToken: ${purchaseToken}`);

    // Verify subscription with Google Play
    const { data: purchase } = await androidPublisher.purchases.subscriptions.get({
      packageName: process.env.PACKAGE_NAME || 'com.rajan.cron',
      subscriptionId,
      token: purchaseToken,
    });

    if (!purchase?.expiryTimeMillis) {
      console.error('[webhook] Invalid/empty purchase data from Google Play');
      throw new Error('No valid expiryTimeMillis returned');
    }

    const expiryMs = Number(purchase.expiryTimeMillis);
    const isActive = expiryMs > Date.now();

    // Save / update in MongoDB
    const db = await getMongoDb();

    const result = await db.collection('subscriptions').updateOne(
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

    console.log(`[webhook] DB update result → matched: ${result.matchedCount}, modified: ${result.modifiedCount}, upserted: ${result.upsertedCount}`);

    console.log(`[webhook] Subscription processed → ${subscriptionId} • active: ${isActive} • expires: ${new Date(expiryMs).toISOString()}`);

    return NextResponse.json({ success: true }, { status: 200 });

  } catch (err: any) {
    console.error('[webhook] Critical error in RTDN handler:', {
      message: err.message,
      stack: err.stack?.substring(0, 800),
      purchaseToken: err.purchaseToken || 'unknown',
    });

    // Still acknowledge Pub/Sub
    return NextResponse.json({}, { status: 200 });
  }
}

// Optional health check endpoint (remove in production if not needed)
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook is alive - use POST method for Google Play notifications',
    timestamp: new Date().toISOString(),
    googleClientReady: !!androidPublisher,
  });
}
