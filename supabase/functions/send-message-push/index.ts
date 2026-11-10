import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

type MessageRecord = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;
  message_type: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-chatflow-webhook-secret",
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  const webhookSecret = Deno.env.get("PUSH_WEBHOOK_SECRET");
  const suppliedSecret = request.headers.get("x-chatflow-webhook-secret") || "";
  if (!webhookSecret || !constantTimeEqual(suppliedSecret, webhookSecret)) {
    return Response.json({ error: "Unauthorized webhook" }, { status: 401, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    console.error("Missing required push function environment variables.");
    return Response.json({ error: "Push delivery is not configured" }, { status: 500, headers: corsHeaders });
  }

  let record: MessageRecord | null = null;
  try {
    const body = await request.json();
    record = (body?.record || body?.data?.record || body) as MessageRecord;
  } catch {
    return Response.json({ error: "Invalid webhook JSON" }, { status: 400, headers: corsHeaders });
  }
  if (!record || !uuidPattern.test(record.id || "")) {
    return Response.json({ error: "Invalid message record" }, { status: 400, headers: corsHeaders });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: message, error: messageError } = await admin.from("messages")
    .select("id, conversation_id, sender_id, content, message_type")
    .eq("id", record.id)
    .maybeSingle();
  if (messageError) {
    console.error("Could not verify push message:", messageError.message);
    return Response.json({ error: "Could not verify message" }, { status: 500, headers: corsHeaders });
  }
  if (!message) return Response.json({ delivered: 0, skipped: "message no longer exists" }, { headers: corsHeaders });

  const { data: participants, error: membersError } = await admin.from("conversation_members")
    .select("user_id")
    .eq("conversation_id", message.conversation_id)
    .neq("user_id", message.sender_id);
  if (membersError) {
    console.error("Could not verify push recipients:", membersError.message);
    return Response.json({ error: "Could not verify recipients" }, { status: 500, headers: corsHeaders });
  }
  const recipientIds = [...new Set((participants || []).map((row) => row.user_id))]
    .filter((id) => uuidPattern.test(id));
  if (!recipientIds.length) return Response.json({ delivered: 0 }, { headers: corsHeaders });

  const [{ data: preferences, error: preferenceError }, { data: subscriptions, error: subscriptionError }] = await Promise.all([
    admin.from("notification_preferences")
      .select("user_id, push_enabled, previews_enabled")
      .in("user_id", recipientIds),
    admin.from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .in("user_id", recipientIds),
  ]);
  if (preferenceError || subscriptionError) {
    console.error("Could not load push configuration:", preferenceError?.message || subscriptionError?.message);
    return Response.json({ error: "Could not load recipient settings" }, { status: 500, headers: corsHeaders });
  }

  const preferenceByUser = new Map((preferences || []).map((preference) => [preference.user_id, preference]));
  const subscriptionsByUser = new Map<string, typeof subscriptions>();
  for (const subscription of subscriptions || []) {
    const current = subscriptionsByUser.get(subscription.user_id) || [];
    current.push(subscription);
    subscriptionsByUser.set(subscription.user_id, current);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  let delivered = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const recipientId of recipientIds) {
    const preference = preferenceByUser.get(recipientId);
    if (!preference?.push_enabled) {
      skipped += 1;
      continue;
    }

    let claimed = await admin.from("message_push_deliveries")
      .insert({ message_id: message.id, recipient_id: recipientId, status: "processing" })
      .select("message_id")
      .maybeSingle();
    if (claimed.error?.code === "23505") {
      claimed = await admin.from("message_push_deliveries")
        .update({ status: "processing", updated_at: new Date().toISOString() })
        .eq("message_id", message.id)
        .eq("recipient_id", recipientId)
        .eq("status", "failed")
        .select("message_id")
        .maybeSingle();
      if (!claimed.data && !claimed.error) {
        skipped += 1;
        continue;
      }
    }
    if (claimed.error) {
      console.error("Could not record push idempotency:", claimed.error.message);
      errors.push(recipientId);
      continue;
    }

    const userSubscriptions = subscriptionsByUser.get(recipientId) || [];
    if (!userSubscriptions.length) {
      await admin.from("message_push_deliveries")
        .update({ status: "skipped" }).eq("message_id", message.id).eq("recipient_id", recipientId);
      skipped += 1;
      continue;
    }

    const preview = preference.previews_enabled
      ? (message.content?.trim() || (message.message_type === "image" ? "Photo"
        : message.message_type === "video" ? "Video"
          : message.message_type === "audio" ? "Voice message" : "File")).slice(0, 140)
      : "You have a new message.";
    const { data: sender } = await admin.from("profiles")
      .select("display_name, avatar_path, avatar_url")
      .eq("id", message.sender_id)
      .maybeSingle();
    let senderIcon = "./assets/icons/icon-192.png";
    if (sender?.avatar_path) {
      const { data: avatar, error: avatarError } = await admin.storage.from("avatars")
        .createSignedUrl(sender.avatar_path, 60 * 60);
      if (avatarError) console.warn("Could not sign sender avatar for push:", avatarError.message);
      else if (avatar?.signedUrl) senderIcon = avatar.signedUrl;
    }
    const payload = JSON.stringify({
      title: sender?.display_name || "New message",
      body: preview,
      icon: senderIcon,
      tag: `chatflow-message-${message.id}`,
      data: { conversationId: message.conversation_id, messageId: message.id },
    });

    let recipientDelivered = false;
    for (const subscription of userSubscriptions) {
      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, payload, { TTL: 60 * 60 });
        recipientDelivered = true;
        delivered += 1;
      } catch (error) {
        const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          const { error: removeError } = await admin.from("push_subscriptions").delete().eq("id", subscription.id);
          if (removeError) console.error("Could not remove expired subscription:", removeError.message);
        } else {
          console.error("Push service delivery failed:", statusCode || "unknown status");
        }
      }
    }
    const { error: deliveryUpdateError } = await admin.from("message_push_deliveries")
      .update({ status: recipientDelivered ? "sent" : "failed" })
      .eq("message_id", message.id)
      .eq("recipient_id", recipientId);
    if (deliveryUpdateError) {
      console.error("Could not update push delivery status:", deliveryUpdateError.message);
    }
    if (!recipientDelivered) errors.push(recipientId);
  }

  if (errors.length) {
    return Response.json({ delivered, skipped, failedRecipients: errors.length }, { status: 500, headers: corsHeaders });
  }
  return Response.json({ delivered, skipped }, { headers: corsHeaders });
});
