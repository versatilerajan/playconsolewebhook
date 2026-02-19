import { NextRequest, NextResponse } from 'next/server';
import { getMongoDb } from '@/lib/mongodb';
import { getFirebaseAdmin } from '@/lib/firebaseAdmin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { purchaseToken } = body;

    if (!purchaseToken) {
      return NextResponse.json({ success: false, message: 'Missing purchaseToken' }, { status: 400 });
    }

    // Verify Firebase token
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ success: false, message: 'Authorization required' }, { status: 401 });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // Save or update subscription with userId
    const db = await getMongoDb();
    await db.collection('subscriptions').updateOne(
      { purchaseToken },
      {
        $set: {
          userId: uid,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    console.log(`[link-subscription] Linked purchaseToken ${purchaseToken} to user ${uid}`);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[link-subscription] Error:', err.message);
    return NextResponse.json({ success: false, message: 'Server error' }, { status: 500 });
  }
}
