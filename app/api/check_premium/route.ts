import { NextRequest, NextResponse } from 'next/server';
import { getMongoDb } from '../../../lib/mongodb'; 
import admin from 'firebase-admin';
import { getFirebaseAdmin } from '../../../lib/firebaseAdmin'; 

export async function GET(req: NextRequest) {
  try {
    // 1. Get token from query
    const token = req.nextUrl.searchParams.get('token');
    if (!token) {
      return NextResponse.json({ premium: false, message: 'Missing token' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ premium: false, message: 'Authorization required' }, { status: 401 });
    }

    const idToken = authHeader.split('Bearer ')[1];

    // 3. Verify token
    const adminSdk = getFirebaseAdmin();
    const decoded = await adminSdk.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // 4. Check active subscription for this user
    const db = await getMongoDb();
    const sub = await db.collection('subscriptions').findOne({
      purchaseToken: token,
      userId: uid, // ← must be saved during purchase or webhook
      isActive: true,
      expiryTimeMillis: { $gt: Date.now() },
    });

    if (sub) {
      return NextResponse.json({
        premium: true,
        expiryTime: new Date(sub.expiryTimeMillis).toISOString(),
      });
    }

    return NextResponse.json({ premium: false });
  } catch (err: any) {
    console.error('[check_premium] Error:', err.message);
    return NextResponse.json({ premium: false, message: 'Server error' }, { status: 500 });
  }
}
