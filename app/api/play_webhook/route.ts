import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { MongoClient } from 'mongodb';

// ────────────────────────────────────────────────
// Global cached MongoDB connection (important for serverless)
let cachedClient: MongoClient | null = null;
let cachedDb: any = null;

async function getMongoDb() {
  if (cachedDb) return cachedDb;

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is missing');
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

  return cachedDb;
}

// ────────────────────────────────────────────────
// Singleton Google Publisher client (initialized once at cold start)
let androidPublisher: any = null;

try {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT environment variable is missing');
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
  console.error('[cold-start] Failed to initialize Google Publisher client:', err.message);
}

// ────────────────────────────────────────────────
// Webhook handler
export async function POST(req: NextRequest) {
  // Must always return 200 to acknowledge Pub/Sub message
  // Returning 4xx/5xx causes redelivery loop → very expensive

  if (!androidPublisher) {
    console.error('Google Publisher client not initialized');
    return NextResponse.json({}, { status: 200 });
  }

  try {
    const body = await req.json();

    if (!body?.message?.data) {
      console.warn('Invalid Pub/Sub format - missing message.data');
      return NextResponse.json({ error: 'Missing message.data' }, { status: 400 });
    }

    // Decode base64 payload
    let payload: any;
    try {
      const raw = Buffer.from(body.message.data, 'base64').toString('utf-8');
      payload = JSON.parse(raw);
    } catch (e: any) {
      console.error('Failed to decode/parse Pub/Sub payload:', e.message);
      return NextResponse.json({}, { status: 200 });
    }

    const notification = payload.subscriptionNotification;
    if (!notification) {
      console.log('Not a subscription notification event');
      return NextResponse.json({}, { status: 200 });
    }

    const { purchaseToken, subscriptionId } = notification;

    if (!purchaseToken || !subscriptionId) {
      console.warn('Missing purchaseToken or subscriptionId');
      return NextResponse.json({}, { status: 200 });
    }

    console.log(`Processing subscription notification → ${subscriptionId} / ${purchaseToken}`);

    // Verify current subscription state from Google Play
    const { data: purchase } = await androidPublisher.purchases.subscriptions.get({
      packageName: process.env.PACKAGE_NAME || 'com.rajan.cron',
      subscriptionId,
      token: purchaseToken,
    });

    if (!purchase?.expiryTimeMillis) {
      throw new Error('Invalid or empty purchase data from Google Play');
    }

    const expiryMs = Number(purchase.expiryTimeMillis);
    const isActive = expiryMs > Date.now();

    // Save / update in MongoDB
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
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
          packageName: process.env.PACKAGE_NAME || 'com.rajan.cron',
        },
      },
      { upsert: true }
    );

    console.log(`Subscription saved/updated → ${subscriptionId} • active=${isActive} • expiry=${new Date(expiryMs).toISOString()}`);

    return NextResponse.json({ success: true }, { status: 200 });

  } catch (err: any) {
    console.error('RTDN webhook error:', {
      message: err.message,
      stack: err.stack?.substring(0, 800),
      purchaseToken: err.purchaseToken || 'unknown',
    });

    // Still acknowledge - critical for Pub/Sub
    return NextResponse.json({}, { status: 200 });
  }
}

// Optional: simple health check (for debugging)
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook is alive - use POST method for Google Play notifications',
    timestamp: new Date().toISOString(),
  });
}
