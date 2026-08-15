const admin = require('firebase-admin');
const { getAdminApp } = require('./_auth');
const ALLOWED_ORIGINS = new Set(['https://jamratghadah.com', 'https://admin.jamratghadah.com']);
function headers(event) {
  const origin = String(event.headers?.origin || '').toLowerCase();
  return {'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://jamratghadah.com','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
}
const valid = (s, max=128) => typeof s === 'string' && s.length > 0 && s.length <= max;
exports.handler = async (event) => {
  const h = headers(event);
  if (event.httpMethod === 'OPTIONS') return {statusCode:204,headers:h,body:''};
  if (event.httpMethod !== 'POST') return {statusCode:405,headers:h,body:JSON.stringify({error:'Method Not Allowed'})};
  const app = getAdminApp();
  if (!app) return {statusCode:503,headers:h,body:JSON.stringify({error:'Database unavailable'})};
  let body; try { body=JSON.parse(event.body||'{}'); } catch { return {statusCode:400,headers:h,body:JSON.stringify({error:'Invalid JSON'})}; }
  const slug=String(body.slug||'').trim(), guestName=String(body.guestName||'').trim(), deviceId=String(body.deviceId||'').trim();
  if (!valid(slug) || !valid(deviceId,100) || guestName.length>120) return {statusCode:400,headers:h,body:JSON.stringify({error:'Invalid input'})};
  try {
    const db=app.firestore(), ref=db.collection('entry_card_locks').doc(slug);
    let result='claimed';
    await db.runTransaction(async tx => {
      const snap=await tx.get(ref);
      if (snap.exists) {
        const existing=snap.data()||{};
        if (existing.deviceId && existing.deviceId !== deviceId) { result='another_device'; return; }
      }
      tx.set(ref,{slug,guestName,deviceId,claimedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    });
    return {statusCode:200,headers:h,body:JSON.stringify({ok:result==='claimed',reason:result==='another_device'?'another_device':undefined})};
  } catch(err) { console.error('[claim-entry-lock]',err.message); return {statusCode:500,headers:h,body:JSON.stringify({error:'Unable to claim device lock'})}; }
};
