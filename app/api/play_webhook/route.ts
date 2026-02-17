import 'dotenv/config'; 

import { google } from 'googleapis';
import { MongoClient } from 'mongodb';
import { NextRequest, NextResponse } from 'next/server';

let cachedClient: MongoClient | null = null;
let cachedDb: any = null;

async function getMongoDb() {
  if (cachedDb) return cachedDb;

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set');
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

// Singleton Google client (created once at cold start)
let androidPublisher: any = null;

try {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT missing in environment');
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

  console.log('[cold-start] Google Play Publisher client ready');
} catch (err: any) {
  console.error('[cold-start] Google client init failed:', err.message);
}

export async function POST(req: NextRequest) {
  if (!androidPublisher) {
    console.error('Google client not available');
    return NextResponse.json({}, { status: 200 }); // must ack Pub/Sub
  }

  try {
    const body = await req.json();

    if (!body?.message?.data) {
      return NextResponse.json({ error: 'Missing message.data' }, { status: 400 });
    }

    let payload: any;
    try {
      const raw = Buffer.from(body.message.data, 'base64').toString('utf-8');
      payload = JSON.parse(raw);
    } catch (e: any) {
      console.error('Pub/Sub decode/parse failed:', e.message);
      return NextResponse.json({}, { status: 200 });
    }

    const notification = payload.subscriptionNotification;
    if (!notification) {
      return NextResponse.json({}, { status: 200 });
    }

    const { purchaseToken, subscriptionId } = notification;

    if (!purchaseToken || !subscriptionId) {
      console.warn('Missing purchaseToken or subscriptionId');
      return NextResponse.json({}, { status: 200 });
    }

    const { data: purchase } = await androidPublisher.purchases.subscriptions.get({
      packageName: process.env.PACKAGE_NAME || 'com.rajan.cron',
      subscriptionId,
      token: purchaseToken,
    });

    if (!purchase?.expiryTimeMillis) {
      throw new Error('Invalid Google Play response');
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
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
          packageName: process.env.PACKAGE_NAME || 'com.rajan.cron',
        },
      },
      { upsert: true }
    );

    console.log(`Updated subscription ${subscriptionId} → active: ${isActive}`);

    return NextResponse.json({ success: true }, { status: 200 });

  } catch (err: any) {
    console.error('RTDN error:', {
      message: err.message,
      stack: err.stack?.slice(0, 600),
    });

    // ALWAYS return 200 to Pub/Sub — otherwise redeliveries loop forever
    return NextResponse.json({}, { status: 200 });
  }
}