const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || "");
const twilio = require("twilio");

admin.initializeApp();
const db = admin.firestore();

function getTwilioClient() {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;

  if (!sid || !token) {
    return null;
  }

  return twilio(sid, token);
}

function normalizePhone(phone) {
  if (!phone) return null;
  return String(phone).replace(/\s+/g, "").replace(/^\+/, "");
}

exports.createCheckoutSession = onCall(async (request) => {
  const { roomCode, playerId, amount, currency = "eur", successUrl, cancelUrl } = request.data || {};

  if (!roomCode || !playerId || !amount) {
    throw new HttpsError("invalid-argument", "Faltan roomCode, playerId o amount.");
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new HttpsError("failed-precondition", "Stripe no está configurado.");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: Math.round(Number(amount) * 100),
          product_data: {
            name: `Entrada Gran Bingo Night - Sala ${roomCode}`,
            description: `Pago del jugador ${playerId}`
          }
        }
      }
    ],
    success_url: successUrl || "https://example.com/pago-exitoso",
    cancel_url: cancelUrl || "https://example.com/pago-cancelado",
    metadata: {
      roomCode,
      playerId
    }
  });

  await db.collection("rooms").doc(roomCode).collection("payments").doc(session.id).set({
    playerId,
    amount: Number(amount),
    currency,
    status: "pending",
    checkoutSessionId: session.id,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    sessionId: session.id,
    url: session.url
  };
});

exports.stripeWebhook = require("firebase-functions/v2/https").onRequest({
  cors: true,
  rawBody: true
}, async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return res.status(400).json({ error: "Falta firma o configuración de Stripe." });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
  } catch (error) {
    return res.status(400).json({ error: `Webhook inválido: ${error.message}` });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { roomCode, playerId } = session.metadata || {};

    if (roomCode && playerId) {
      await db.collection("rooms").doc(roomCode).collection("payments").doc(session.id).set({
        playerId,
        roomCode,
        status: "succeeded",
        receiptUrl: session.customer_details?.invoice_settings?.default_payment_method || null,
        amount: session.amount_total ? session.amount_total / 100 : 0,
        currency: session.currency || "eur",
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }

  return res.json({ received: true });
});

exports.sendWhatsAppAnnouncement = onCall(async (request) => {
  const { roomCode, message } = request.data || {};

  if (!roomCode || !message) {
    throw new HttpsError("invalid-argument", "Faltan roomCode o message.");
  }

  const roomSnap = await db.collection("rooms").doc(roomCode).get();

  if (!roomSnap.exists) {
    throw new HttpsError("not-found", "La sala no existe.");
  }

  const roomData = roomSnap.data();
  const players = roomData.jugadores || {};
  const client = getTwilioClient();

  if (!client) {
    throw new HttpsError("failed-precondition", "Twilio no está configurado.");
  }

  const sent = [];

  for (const player of Object.values(players)) {
    const phone = normalizePhone(player.telefono);
    if (!phone) continue;

    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${phone}`,
      body: message
    });

    sent.push(player.nombre || "Jugador");
  }

  return {
    sentTo: sent.length,
    names: sent
  };
});

exports.notifyNumberDraw = onDocumentUpdated("rooms/{roomCode}", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};

  if (!after || !after.jugadores) return;
  if (before.numeroActual === after.numeroActual) return;

  const message = `🎱 Gran Bingo Night: se ha sacado el número ${after.numeroActual}. Historial: ${(after.historial || []).join(", ")}`;
  const client = getTwilioClient();

  if (!client) return;

  for (const player of Object.values(after.jugadores)) {
    const phone = normalizePhone(player.telefono);
    if (!phone) continue;

    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${phone}`,
      body: message
    });
  }
});
