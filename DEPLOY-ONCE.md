# v10.31 one-time deployment steps

1. Deploy Firestore rules: `firebase deploy --only firestore:rules`
2. Set Netlify environment variables from `.env.example`. Do not commit real values.
3. For each invitation slug, set its `INVITE_ACCESS_<SLUG>` variable to the existing production access code.
4. Ensure `FIREBASE_SERVICE_ACCOUNT_JSON` and `RSVP_TOKEN_SECRET` are present.
5. Ensure `CHECKIN_PASSWORD` is present before event day.
6. Enable Firestore TTL on `rate_limits.expiresAt`.
7. Deploy the entire site and functions together; do not mix old production files with this version.
8. After deployment, rerun the production audit.
