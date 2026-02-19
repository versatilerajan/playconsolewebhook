
import admin from 'firebase-admin';

let firebaseAdmin: admin.app.App | null = null;

export function getFirebaseAdmin(): admin.app.App {
  if (firebaseAdmin) {
    return firebaseAdmin;
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT environment variable is missing. ' +
      'It should contain the full JSON string of your Firebase service account key.'
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('[Firebase Admin] Successfully parsed FIREBASE_SERVICE_ACCOUNT');
    console.log('[Firebase Admin] Project ID:', serviceAccount.project_id);
    console.log('[Firebase Admin] Client email:', serviceAccount.client_email);
  } catch (parseError) {
    console.error('[Firebase Admin] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', parseError);
    throw new Error('FIREBASE_SERVICE_ACCOUNT contains invalid JSON');
  }

  // Fix private key: convert escaped \n to actual newlines
  const privateKey = serviceAccount.private_key.replace(/\\n/g, '\n');

  try {
    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: privateKey,
      }),
    });

    console.log('[Firebase Admin] Successfully initialized with project:', serviceAccount.project_id);
  } catch (initError) {
    console.error('[Firebase Admin] Failed to initialize Firebase Admin SDK:', initError);
    throw initError;
  }

  return firebaseAdmin;
}
