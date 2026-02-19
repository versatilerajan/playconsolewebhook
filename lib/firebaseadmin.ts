// lib/firebaseAdmin.ts
import admin from 'firebase-admin';

let firebaseAdmin: admin.app.App | null = null;

export function getFirebaseAdmin() {
  if (firebaseAdmin) return firebaseAdmin;

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  firebaseAdmin = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key.replace(/\\n/g, '\n'),
    }),
  });

  return firebaseAdmin;
}
