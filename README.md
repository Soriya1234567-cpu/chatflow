# ChatFlow PWA

A real-time private and group chat starter built with HTML, CSS, vanilla JavaScript, Supabase Auth, PostgreSQL, and Supabase Realtime.

## Features

- Email/password sign-up and sign-in
- Editable profiles with display name, username, bio, status, and managed avatars
- Private conversations and named group chats with contact selection and owner-managed names/photos
- Live online status and approximate last-seen duration for contacts
- Remove a direct-chat contact from your own list without affecting their account or chat
- Real-time message inserts without refresh
- Message history stored in PostgreSQL
- Cursor-paginated message history
- Author-only message editing and deletion
- Emoji reactions and read receipts
- Private photo, video, and voice message attachments
- Voice recording with pause/resume, preview, and cancel
- Typing indicator (Realtime Broadcast)
- Conversation search, responsive mobile layout, installable PWA shell
- PostgreSQL Row Level Security (RLS)
- Offline caching for static app files only; authenticated API responses are never cached

## Requirements

- A Supabase project
- A modern browser
- A local static server (do not open `index.html` directly as `file://`)

## 1. Set up Supabase

1. Create a project at https://supabase.com/dashboard.
2. Open **SQL Editor** in your Supabase project.
3. Run all of `supabase/schema.sql`.
4. Run `supabase/profile_avatars.sql` to add profile editor fields, update-only-self policies, avatar Storage policies, and profile Realtime updates.
5. Run `supabase/profile_discovery.sql` to enable authenticated user search and safe profile cards.
6. Open **Project Settings → API** (or API Keys) and copy your project URL and the public publishable key / legacy anon key.
7. Put those values in `js/config.js`.
8. Under **Authentication → URL Configuration**, set the Site URL to your local origin while developing (for example `http://localhost:5500`). Add any other local/deployed redirect URLs you use.
9. For easiest local testing, keep email confirmation enabled and confirm both test accounts from their email inboxes. Alternatively, disable email confirmation only in a private development project.
10. Run `supabase/messaging_media.sql` to add messaging support and create the private `chat-attachments` bucket with member-scoped Storage policies.
11. Run `supabase/notifications.sql` to add unread-count RPCs and private notification preference/subscription tables.
12. Run `supabase/group_chat_management.sql` to add group photos and owner-only group detail updates.
13. Run `supabase/contact_management.sql` to enable per-user removal and restoration of direct-chat contacts.
14. Run `supabase/contact_presence.sql` to enable live online and last-seen status for conversation contacts.

Never put a `service_role` or secret key in `js/config.js`, source control, or any browser code.

## 2. Configure the app

Edit `js/config.js`:

```js
window.CHATFLOW_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_ID.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_PUBLIC_PUBLISHABLE_OR_ANON_KEY"
};
```

The public key is intended to be used in a browser. Safety depends on correct RLS policies, not on hiding the public key.

## 3. Run locally

### Option A: VS Code Live Server
1. Open the `chatflow-pwa` folder in VS Code.
2. Install the **Live Server** extension if needed.
3. Right-click `index.html` → **Open with Live Server**.
4. Use the displayed localhost URL, commonly `http://127.0.0.1:5500`.

### Option B: Python static server
From PowerShell in the project folder run:

```powershell
python -m http.server 5500
```

Then open http://localhost:5500.

Or start it from another PowerShell window with:

```powershell
Set-Location -LiteralPath 'C:\Users\SORIYA.MUT\Documents\TERM 3\Subjects\Javascript\Demo\chatflow-pwa'
python -m http.server 5500
```

Service workers require HTTPS or localhost. Do not open the HTML file directly.

## 4. Test with two users

1. Open the app in a normal browser window.
2. Register User A with a real email address you can confirm.
3. Open a private/incognito window or a second browser.
4. Register User B with a different email address and confirm it.
5. Sign in to both sessions.
6. From User A, press `+`, choose **Private message**, enter User B's registered email, and create the conversation.
7. Send a message. It should appear in User B's open conversation without a page refresh.
8. Test the typing indicator by typing in one session.
9. Create a group by selecting existing direct-chat contacts and/or entering registered email addresses, then provide a group name.
10. Open a group’s **Conversation info** to change its name or photo (only the group creator can edit these details).
11. In a group’s **Conversation info**, add contacts from your direct chats; verify only new members gain access to the group.
12. As the group creator, delete a test group and confirm it disappears for all members. Verify a non-owner cannot delete it.
13. Send text, photos, videos, and voice messages between the two users; verify previews, reactions, visible-message read receipts, editing, and deletion.
14. Record a voice message, pause/resume it, stop and preview it, then try canceling a recording and an in-progress upload.
15. Load older messages and confirm only conversation members can open signed attachment links.

Each browser session must be signed into a different user. If email confirmation is enabled, confirm each account before signing in.

## 5. PWA installation and offline behavior

- The **Install ChatFlow on this device** button on the sign-in screen and the install guide in the conversation list explain mobile steps for Android/Chrome and iPhone/iPad/Safari.
- On Android, open ChatFlow in Chrome, tap **⋮**, then **Install app** or **Add to Home screen**, and confirm.
- On iPhone or iPad, open ChatFlow in Safari, tap **Share**, choose **Add to Home Screen**, then tap **Add**. If the option is missing, scroll the share sheet or add the action from **Edit Actions**.
- On browsers that support it, the in-app guide also provides an **Install ChatFlow** button. Installation requires a secure context (HTTPS, or localhost for development); private browsing or unsupported browsers may not offer installation.
- The service worker caches the static app shell only.
- Authentication, message history, and live messaging require a network connection. Offline caching does not make the backend or message sending work offline.
- Unread counts reconcile from database read receipts after reconnect. Browser notifications require the page/service worker and permission; delivery while the PWA is closed requires the separately deployed Web Push backend below.
- If you change static assets, bump `CACHE_NAME` in `service-worker.js` (for example `chatflow-shell-v24`).

## 6. Messaging and attachment setup

- Run the incremental `supabase/messaging_media.sql` migration after the original schema. It adds message metadata, reactions, read receipts, author-only edit/delete policies, a private attachment bucket, and Storage RLS policies.
- Run `supabase/group_chat_management.sql` after `schema.sql` and the messaging/profile migrations. It adds the `group_avatar_path` column and private `group-avatars` bucket, a function allowing group members to add their direct-chat contacts, and an owner-only group deletion function. Group creators (not other members) can update group names/photos. Existing deployments must apply this migration before using group management.
- Run `supabase/contact_management.sql` after `schema.sql`. It adds a per-user hidden state and a secured function for removing or restoring direct-chat contacts. Removing a contact only hides that direct conversation from the current user's list; it does not delete messages or change the other person's list. Opening that person's profile and starting a chat restores the conversation.
- Run `supabase/contact_presence.sql` after `schema.sql` to show live online status and how long a contact has been offline. A 30-second heartbeat updates last-seen time; a contact is shown online for up to 90 seconds after their last heartbeat. Offline time is approximate, particularly if their browser is backgrounded or loses its connection.
- If messaging media was already configured, rerun the updated `supabase/messaging_media.sql` to allow voice messages alongside photo and video uploads.
- If `messaging_media.sql` was applied before its Storage policies were scoped by bucket, run `supabase/storage_policy_scope_fix.sql` once before `profile_discovery.sql`. The restrictive attachment policies must apply only to `chat-attachments`, not unrelated Storage buckets such as `avatars`.
- The attachment picker accepts JPEG, PNG, and WebP photos plus MP4 and WebM videos. Files are limited to 25 MB and checked against their content signatures in the browser as well as bucket MIME/size limits.
- Use the microphone button beside the composer to record a voice message. The photo/video picker remains limited to images and videos.
- Images and media use short-lived signed URLs. Only authenticated members of the conversation can read its objects; uploads use random object names under the conversation and uploader IDs.
- Group creation can combine selected direct-chat contacts with registered emails; duplicate members are removed before the creation RPC runs. Any group member can add contacts from their own direct chats in **Conversation info**. The database function validates contact relationships and limits groups to 51 members. Only the creator can change group names/photos or delete the group. Deletion removes the group, membership, messages, and message metadata from the database; private Storage objects for attachments or the group photo may remain orphaned and inaccessible because attachment deletion is limited to the uploader and group-photo access is scoped to an existing group.
- Text messages are loaded in pages of 50. Use **Load earlier messages** to fetch older history.
- Uploads use a single Storage request with progress and cancellation, and are capped at 25 MB. Resumable large-file uploads are not implemented.
- Voice recording requires microphone permission and a secure browser context (HTTPS or localhost). Recordings can be paused/resumed, stopped, previewed, discarded, and then sent.
- Removing a message deletes its database row. Attachment cleanup is attempted afterward; if Storage cleanup fails, the orphaned private object remains inaccessible to non-members and the error is shown.

## 7. Message notifications and Web Push

- The **bell** opens notification preferences. On first sign-in per account and browser, ChatFlow offers a notification welcome prompt; browser permission is requested only after the user chooses **Enable notifications**. Their choice not to enable is remembered for that browser. Desktop permission, sound, and preview settings are managed in preferences; denied or unsupported browser notifications do not disable in-app toasts or unread counts.
- Unread counts are calculated from `message_reads`, are reflected in conversation/sidebar badges, the document title, and `navigator.setAppBadge` where supported. The existing message observer marks messages read when they become visible.
- Apply `supabase/notifications.sql` after `schema.sql` and `messaging_media.sql`. Its policies limit notification preferences and push subscription data to their owner; the delivery ledger is service-role-only.
- In `js/config.js`, set `VAPID_PUBLIC_KEY` to the **public** VAPID key. This key is safe to expose; never put the VAPID private key, `PUSH_WEBHOOK_SECRET`, or service-role key in the frontend.
- Generate a VAPID pair with `npx --yes web-push generate-vapid-keys`. Generate a separate webhook secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep the private key and webhook secret in a password manager / deployment secrets, not source control.
- Install and link the Supabase CLI, then deploy the Edge Function and secrets (PowerShell example; replace the placeholders locally):

  ```powershell
  supabase login
  supabase link --project-ref YOUR_PROJECT_REF
  supabase secrets set --project-ref YOUR_PROJECT_REF `
    VAPID_PUBLIC_KEY="YOUR_PUBLIC_KEY" `
    VAPID_PRIVATE_KEY="YOUR_PRIVATE_KEY" `
    VAPID_SUBJECT="mailto:admin@example.com" `
    PUSH_WEBHOOK_SECRET="YOUR_RANDOM_WEBHOOK_SECRET"
  supabase functions deploy send-message-push --project-ref YOUR_PROJECT_REF --no-verify-jwt
  ```

- In Supabase Dashboard, open **Database → Webhooks** and create a webhook on `public.messages`, **INSERT** only. Use `POST` URL `https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-message-push`, add header `x-chatflow-webhook-secret` with the exact `PUSH_WEBHOOK_SECRET`, and save. The function independently verifies the webhook secret, reloads the inserted message and conversation recipients from the database, excludes the sender, checks each recipient's push preference, and uses a unique message/recipient delivery record to suppress duplicates. Expired endpoints (HTTP 404/410) are deleted.
- The service worker handles Push events and notification clicks without replacing its offline shell cache. It accepts only UUID conversation/message destinations and focuses/navigates an existing ChatFlow window or opens the app. Supabase Realtime drives foreground/in-app alerts; only Web Push can deliver while the app is closed.
- To receive mobile Web Push, use HTTPS and a supported browser. Android Chrome/Edge supports installed PWAs; iOS/iPadOS requires a Home Screen-installed web app on iOS/iPadOS 16.4 or newer and user permission. Browser support and OS settings can still prevent delivery. Test on a real device after configuring the webhook and VAPID secrets.
- Disabling push updates the server-side preference before removing the browser subscription, so webhook delivery skips the account. Disabling previews sends only a generic body; desktop previews use the same setting.

### Notification test checklist

1. Apply `notifications.sql`, sign in to two accounts, and enable desktop alerts from **Notification settings** on the receiver.
2. Send a message from the other account while viewing another conversation: verify one toast, unread badges/title count, and a working click-through.
3. Keep the receiver's target conversation focused: verify no unnecessary alert and that read receipts clear its unread count.
4. Send from the receiver account; verify the sender gets no notification.
5. Disable browser permission or use an unsupported browser; verify unread/in-app indicators still work.
6. With the Edge Function, secrets, and database webhook configured, enable push and test with the tab backgrounded and closed. Turn previews off and verify the push body is generic; disable push and verify subsequent pushes stop.
7. Test a Home Screen-installed iOS 16.4+ PWA and an installed Android PWA separately. Remove a subscription or revoke permission and verify HTTP 404/410 endpoints are cleaned up and no expired endpoint keeps failing.

## 8. Profile editor and avatar storage

- Use **Discover people** to see suggested users you do not already have a private chat with, or search registered users by display name or username. Select **View profile** to see the read-only profile card, or **Message** to start a private chat. Profile links in direct conversations, messages, and group participant details open the same profile card. Only your own card has an **Edit profile** button.
- Run `supabase/profile_discovery.sql` after `profile_avatars.sql`. It adds bounded profile search, suggestions, and single-profile RPCs that return only display name, username, avatar references, bio, status, and update time—not email. Suggestions prioritize newer profiles and are available only to authenticated users; conversation/message data remains protected by its existing RLS.
- If ChatFlow is already deployed, rerun the updated `supabase/profile_discovery.sql` in the Supabase SQL Editor to install the suggestions RPC.
- Run the updated `supabase/messaging_media.sql` in the Supabase SQL Editor to limit new attachments to photos and videos.
- The sidebar pencil button opens **Edit profile**. Profile changes use an authenticated `UPDATE` against the signed-in user's `profiles` row; email, user ID, and other protected fields are not sent or granted for editing.
- The editor validates a non-empty display name, username format/uniqueness, biography/status limits, and JPEG/PNG/WebP file signatures and size (5 MB maximum). A selected photo is previewed locally and is not uploaded until **Save changes**.
- Avatars are stored under `<auth-user-uuid>/<random-filename>` in the `avatars` bucket. RLS policies enforce ownership by the first folder segment for upload, replacement, and deletion. The prior avatar is deleted only after the profile row has been updated. If the database update fails, the new upload is cleaned up and the old profile stays in place; cleanup failures are reported.
- Existing `avatar_url` values that point to this project's `avatars` bucket are recognized and refreshed as signed URLs when needed, including expired signed links. If signing fails, the app shows the default avatar rather than repeatedly requesting a broken public URL, and **Edit profile** lets you replace or remove the saved photo. If the referenced object no longer exists, re-upload the photo.
- `profile_avatars.sql` creates a public `avatars` bucket when one does not exist. Public bucket images can be fetched by anyone who has their URL; do not put private information in avatars. If an `avatars` bucket already exists, its public/private visibility is preserved. The profile discovery migration permits authenticated users to read avatar objects so private-bucket signed URLs work for directory profiles; uploads and deletes remain owner-only.
- The migrations restrict profile updates to editable columns and keep the existing profile RLS check that users can update only their own row. Apply `schema.sql`, `profile_avatars.sql`, `profile_discovery.sql`, `messaging_media.sql`, `notifications.sql`, then `group_chat_management.sql` for a new project; for an existing installation, apply the migrations not already run, in that order. If the older attachment policies are already installed, run `storage_policy_scope_fix.sql` before `profile_discovery.sql`.

### Profile acceptance checklist

1. Sign in, open the sidebar pencil action, edit display name, username, bio, and status, then save. Confirm the new name/avatar render in the sidebar, conversations, active chat, message list, and conversation details.
2. Refresh the browser and sign out/in; confirm profile values persist.
3. Select a valid JPEG, PNG, or WebP under 5 MB. Verify the preview appears before saving; choose **Cancel selection** or cancel the editor and confirm the stored avatar is unchanged.
4. Try an unsupported format, a file over 5 MB, and a renamed non-image file; confirm all are rejected.
5. Replace an avatar, then remove it and save. Confirm the default avatar returns. Check the Storage bucket for the old object; deletion errors should be reported rather than silently ignored.
6. From two accounts, search for each other and open profile cards from directory results, direct-chat headers, messages, and group details. Confirm email is not displayed, profile cards have no edit controls for other users, and **Message** opens the correct direct chat.
7. Attempt to update another user's profile row or upload/delete in their avatar folder; confirm profile and Storage policies reject those actions. Private messages and conversations must remain unavailable to non-members.

## Security notes and limitations

- RLS policies restrict conversation/message access to conversation members.
- Conversation creation is handled by a database function that includes the caller and validates member IDs.
- The app uses only a browser-safe public Supabase key. Never use the service-role key client-side.
- The email lookup RPC remains for creating conversations from an explicitly entered email. The directory uses separate RPCs that do not return email addresses; add abuse controls or rate limits before exposing a large public service.
- Closed-app push is not active until VAPID secrets, the Edge Function, and database webhook have all been configured and deployed. Web Push is best-effort and subject to browser/OS delivery behavior. End-to-end encryption, group member removal, message search, and explicit delivered-status indicators are not implemented.
- Typing state is sent via Realtime Broadcast and is ephemeral; it is not persisted.
- Apply Supabase Auth rate limits, configure email templates/redirects, and review RLS policies before deploying to real users.
- Group members can read all messages in their group. Any current member can add their direct-chat contacts; only the group creator can delete the group or edit its details.
- Supabase Realtime Postgres Changes are subject to RLS and project limits.

## Suggested next steps

1. Add group member management through validated SQL RPC functions.
2. Add message search and unread conversation counts.
3. Add notification muting per conversation and rate limits for directory discovery.
4. Add abuse reporting, rate limits, and account deletion controls before public launch.
