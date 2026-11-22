# Members: sending sign-in codes by WhatsApp — owner setup

Date: 2026-11-23 · For: the owner · Spec: `docs/superpowers/specs/2026-11-22-members-phone-points-design.md` §5

A guest who joins on the QR page gets a 6-digit code on WhatsApp. The message goes out through Meta's
WhatsApp Cloud API directly (no reseller). The `member-auth` function is already built for it. What is
left is the Meta side, which only the owner can set up, plus five secrets.

Facts marked **(re-check)** come from Meta's docs on 2026-11-23 and change from time to time. Check them
on developers.facebook.com before you rely on them.

## What you need first

1. A **Meta Business account for Craftale Sdn Bhd that has passed business verification** (Business
   Settings → Security Centre → Start verification; SSM documents). An unverified business can still
   test, but only with a small number of recipients. **(re-check the limits)**
2. A **phone number that is not in use on the WhatsApp or WhatsApp Business app**. Use a new SIM or a
   landline that can take a voice call for the verification code. A number already on WhatsApp has to be
   deleted from that app first, and its chats are lost.
3. A **payment method on the WhatsApp Business Account**. Authentication messages are charged per
   message delivered.

## Set up on Meta

1. Go to developers.facebook.com → **My Apps → Create app**, type **Business**, and link it to the
   Craftale business portfolio.
2. In the app, **Add product → WhatsApp → Set up**. This creates (or links) a **WhatsApp Business
   Account (WABA)**. Write down the **WhatsApp Business Account ID**.
3. **WhatsApp → API Setup → Add phone number**. Enter the display name (`Craft Cafe`; Meta reviews it),
   the category, and the number from "What you need first". Verify it by SMS or voice call. Write down
   the **Phone number ID**. This is a different number from the WABA ID.
4. Meta Business Suite → **Business Settings → Users → System users → Add**. Name it `craft-os`, role
   **Admin**. Then **Add assets**: give it the app (full control) and the WhatsApp account (full control).
5. On that system user: **Generate new token**. Pick the app, set expiry to **Never**, and tick the
   scopes **`whatsapp_business_messaging`** and **`whatsapp_business_management`**. Copy the token
   straight into a password manager. Do not paste it into chat or into any file in the repository.
6. Business Settings → **WhatsApp accounts → (your account) → Payment settings**. Add the payment method.

## Create the sign-in template (once)

Run this in **your own terminal**. The token is read from an environment variable, so it never appears
in the command. Paste the token at the hidden prompt:

```bash
read -rs WA_TOKEN && export WA_TOKEN      # paste the System User token, press Enter (nothing shows)
WABA_ID=<your WhatsApp Business Account ID>

curl -sS "https://graph.facebook.com/v27.0/$WABA_ID/message_templates" \
  -H "Authorization: Bearer $WA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "craft_signin_code",
    "language": "en_US",
    "category": "authentication",
    "message_send_ttl_seconds": 300,
    "components": [
      { "type": "body", "add_security_recommendation": true },
      { "type": "footer", "code_expiration_minutes": 5 },
      { "type": "buttons", "buttons": [ { "type": "otp", "otp_type": "copy_code", "text": "Copy code" } ] }
    ]
  }'
```

- The answer looks like `{"id":"…","status":"PENDING","category":"AUTHENTICATION"}`. Approval usually
  arrives within minutes. You can see the status under WhatsApp Manager → Message templates.
- The wording is **Meta's and cannot be changed**: `<code> is your verification code. For your
  security, do not share this code.` / `This code expires in 5 minutes.` and a `Copy code` button. No
  logo, link or emoji. **(re-check)**
- `v27.0` was the version in Meta's example on 2026-11-23. `message_send_ttl_seconds: 300` stops Meta
  from delivering a code after it has expired. **(re-check the allowed range for authentication
  templates)**
- Meta stores the button as type `URL`. That is expected **(re-check)**.

## Set the secrets

Run these in **your own terminal**, from the Craft OS folder. Type the values yourself. Run dev first.

```bash
# DEV (craft-os-dev)
supabase secrets set --project-ref egznnbjmicebbhwasloy \
  WHATSAPP_TOKEN="$WA_TOKEN" \
  WHATSAPP_PHONE_NUMBER_ID=<phone number id> \
  WHATSAPP_TEMPLATE=craft_signin_code \
  WHATSAPP_TEMPLATE_LANG=en_US \
  WHATSAPP_GRAPH_VERSION=v27.0
supabase secrets set --project-ref egznnbjmicebbhwasloy SMS_PROVIDER=whatsapp
```

`SMS_PROVIDER` keeps its old name, but it now picks the channel: `log` (dev, nothing is sent) or
`whatsapp`. To go back to dev testing without WhatsApp, run `supabase secrets set --project-ref
egznnbjmicebbhwasloy SMS_PROVIDER=log`.

**Prod comes later**, after the members feature goes live there. Run the same two commands with prod's
project ref, and set `MEMBER_AUTH_ORIGINS` there to the address guests' QR pages are served from (the
function refuses requests from any other site). Never set `MEMBER_AUTH_ALLOW_LOG` on prod.

## Test it

1. On the dev QR page (scan a Demo table's QR code, or open `https://craft-os-dev.vercel.app/t/<table token>`), tap **Join & earn points**,
   type **your own** mobile number and tap **Send code**.
2. WhatsApp should show the code from `Craft Cafe` within a few seconds. Tap **Copy code**, go back to
   the page and paste it. The sheet signs you in.
3. If nothing arrives, or the sheet says `Sign-in is not available yet.`, check the function's logs in the
   Supabase dashboard (Edge Functions → member-auth → Logs). A failed send logs `sendCode whatsapp ••1234`,
   the reason, and Meta's `code`, `subcode` and `fbtrace_id`. Common codes: `190` means the token is
   wrong or has expired, `132001` means the template is not approved or the name or language is wrong,
   `131026` means the number cannot get the message, and `131056` means too many messages went to the
   same number. **(re-check on Meta's error-codes page)**

## Cost

Meta's rate for an **authentication** message to a Malaysian number from a Malaysia-based business is
about **RM 0.056 per message**. Check Meta's rate card for the current figure; prices are set per
country and change. **(re-check)** At the default cap of 300 codes a day, the most this can cost is about
RM 17 a day. You can change the cap in the back office under Members → Settings → `Sign-in codes per day`.

## Guests without WhatsApp

They cannot sign in on the QR page. Under the code boxes the sheet says `Nothing in WhatsApp? Check the
number, or ask our staff to add it for you.` Staff add the number to the bill at the counter, and the
points are earned the same way.
