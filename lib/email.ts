import { Resend } from "resend";
import { money } from "./money";
import { safeHttpUrl } from "./safe-url";
import { orderPageUrl } from "./app-url";

const key = process.env.RESEND_API_KEY || "";
const from = process.env.MAIL_FROM || "Welcome Tomorrow <seo@welcometomorrow.io>";
const resend = key ? new Resend(key) : null;

/** Where internal notifications (new orders, signups, applications) are sent. */
export const ADMIN_NOTIFY = process.env.ADMIN_NOTIFY_EMAIL || "seo@welcometomorrow.io";

export const emailEnabled = (): boolean => !!resend;

/**
 * Plain-text copy of an HTML email. Gmail scores HTML-only mail as more likely
 * to be bulk/spam, so every message goes out with both parts.
 */
function htmlToText(html: string): string {
  return html
    .replace(/\s+/g, " ")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return l && l !== href ? `${l}: ${href}` : href;
    })
    .replace(/<img[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h1|h2|div)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function send(to: string, subject: string, html: string, replyTo?: string): Promise<boolean> {
  if (!resend) {
    console.error(`[email] RESEND_API_KEY is not set - "${subject}" to ${to} was not sent.`);
    return false;
  }
  try {
    // The Resend SDK does NOT throw when the API rejects a message; it returns
    // { data, error }. Checking only for thrown exceptions reported every
    // rejection as a success, which is why failures were invisible.
    // Every mail gets a real Reply-To (the desk inbox) and a plain-text part:
    // both are trust signals Gmail uses when deciding inbox vs spam.
    const res: any = await resend.emails.send({
      from,
      to,
      subject,
      html,
      text: htmlToText(html),
      replyTo: replyTo || ADMIN_NOTIFY,
    });
    if (res?.error) {
      console.error(
        `[email] REJECTED "${subject}" to ${to} from "${from}": ${res.error.name || ""} ${res.error.message || JSON.stringify(res.error)}`
      );
      return false;
    }
    console.log(`[email] sent "${subject}" to ${to} (id ${res?.data?.id || "unknown"})`);
    return true;
  } catch (e: any) {
    console.error(`[email] FAILED "${subject}" to ${to}: ${e?.message || e}`);
    return false;
  }
}

/** Escape user-supplied text before putting it in an HTML email. */
export function escHtml(s: string): string {
  return esc(s);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "<br>");
}

/** Chat / contact form -> the SEO desk inbox, with the visitor set as reply-to. */
export function sendContactEmail(input: { name: string; email: string; message: string }) {
  return send(
    ADMIN_NOTIFY,
    `New chat message from ${input.name}`,
    wrap(
      "New message from the Link Tomorrow chat",
      `<p><strong>Name:</strong> ${esc(input.name)}</p>
       <p><strong>Email:</strong> ${esc(input.email)}</p>
       <p><strong>Message:</strong></p>
       <p>${esc(input.message)}</p>`
    ),
    input.email
  );
}

/**
 * The Welcome Tomorrow mark, served from the app's own public folder so it has a
 * stable absolute URL. Email clients cannot load relative paths, and many block
 * remote images until the reader allows them - hence the alt text.
 */
const logoUrl = (): string =>
  `${(process.env.APP_URL || "https://tools.welcometomorrow.io/linktomorrow").replace(/\/$/, "")}/email-logo.png`;

const wrap = (title: string, body: string) => `
  <div style="font-family:Outfit,Arial,sans-serif;background:#000;color:#fff;padding:32px;border-radius:20px">
    <img src="${logoUrl()}" width="52" height="52" alt="Welcome Tomorrow"
         style="display:block;border:0;outline:none;text-decoration:none;border-radius:12px;margin:0 0 20px" />
    <h1 style="color:#0aa865;margin:0 0 16px">${title}</h1>
    <div style="font-size:16px;line-height:1.5;color:#fff">${body}</div>
    <p style="color:rgba(255,255,255,.6);font-size:13px;line-height:1.5;margin-top:24px">Link Tomorrow is run by Welcome Tomorrow, a marketing agency.<br>Questions? Just reply to this email and our team will answer.</p>
  </div>`;

export function sendInviteEmail(to: string, link: string) {
  // Written as a personal note, not a promo: no "marketplace" pitch, no
  // urgency, the link shown in full as well as on the button. Publishers get a
  // lot of automated link-building mail, and Gmail had learned to file ours
  // with it.
  return send(
    to,
    "Your publisher account on Link Tomorrow",
    wrap(
      "Your publisher account is ready to set up",
      `<p>Hello,</p>
       <p>The Welcome Tomorrow team has set up a publisher account for you on Link Tomorrow, where
          we order guest posts and sponsored articles from website owners. Once your account is set
          up you can list your websites, set your own prices, and get paid for each article you
          publish.</p>
       <p><a href="${link}" style="display:inline-block;background:#0aa865;color:#fff;padding:14px 28px;border-radius:30px;text-decoration:none;font-weight:700">Set up my account</a></p>
       <p style="color:rgba(255,255,255,.6);font-size:14px">Or paste this address into your browser:<br>
          <a href="${link}" style="color:#0aa865;word-break:break-all">${link}</a></p>
       <p style="color:rgba(255,255,255,.6);font-size:14px">The link works for 7 days. If you were not expecting this, you can ignore it.</p>`
    )
  );
}

/** Send the 6-digit confirmation code the user types into the confirm screen. */
export function sendVerificationCodeEmail(to: string, code: string) {
  return send(
    to,
    `${code} is your Link Tomorrow confirmation code`,
    wrap(
      "Confirm your email",
      `<p>Enter this 6-digit code on the confirmation screen to activate your account:</p>
       <p style="font-size:34px;font-weight:800;letter-spacing:10px;color:#0aa865;margin:24px 0">${esc(code)}</p>
       <p style="color:rgba(255,255,255,.6)">This code expires in 15 minutes. If you did not create a Link Tomorrow account, you can ignore this email.</p>`
    )
  );
}

export function sendOrderNotice(to: string, subject: string, message: string) {
  return send(to, subject, wrap(subject, `<p>${message}</p>`));
}

/** Deposit succeeded -> confirm to the buyer and promise an invoice within 24h. */
export function sendDepositReceipt(to: string, grossCents: number, netCents: number) {
  return send(
    to,
    "Your deposit was successful",
    wrap(
      "Deposit received",
      `<p>We have received your deposit of <strong>${money(grossCents)}</strong>.</p>
       <p>After the 5% service fee, <strong>${money(netCents)}</strong> has been added to your wallet balance and is ready to use.</p>
       <p>Your invoice will be emailed to you within 24 hours.</p>`
    )
  );
}

/** Download links for an order's files; absent when the order has no such file. */
export type OrderFileLinks = { doc?: string; image?: string; text?: string };

/** A green pill button, with the full address shown underneath (deliverability rule). */
function button(href: string, label: string): string {
  return `<p style="margin:20px 0 6px"><a href="${esc(href)}" style="display:inline-block;background:#0aa865;color:#fff;padding:14px 28px;border-radius:30px;text-decoration:none;font-weight:700">${esc(label)}</a></p>`;
}

function fullLink(href: string, intro = "Or paste this address into your browser:"): string {
  return `<p style="color:rgba(255,255,255,.6);font-size:13px;margin:0 0 16px">${esc(intro)}<br>
          <a href="${esc(href)}" style="color:#0aa865;word-break:break-all">${esc(href)}</a></p>`;
}

/** A plain download link, one per line. */
function downloadLine(href: string, label: string): string {
  return `<a href="${esc(href)}" style="color:#0aa865;font-weight:600">&#11015; ${esc(label)}</a>`;
}

/** The order brief as label/value rows. Values are escaped; the target URL is only linked if safe. */
function briefRows(input: { targetUrl?: string | null; anchorText?: string | null; notes?: string | null }): string {
  const rows: string[] = [];
  const target = safeHttpUrl(input.targetUrl);
  if (input.targetUrl) {
    rows.push(
      `<strong>Target URL:</strong> ${
        target ? `<a href="${esc(target)}" style="color:#0aa865;word-break:break-all">${esc(target)}</a>` : esc(input.targetUrl)
      }`
    );
  }
  if (input.anchorText) rows.push(`<strong>Anchor text:</strong> ${esc(input.anchorText)}`);
  if (input.notes) rows.push(`<strong>Notes from the buyer:</strong> ${esc(input.notes)}`);
  return rows.length ? `<p>${rows.join("<br>")}</p>` : "";
}

const longDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * New paid order -> the publisher and the admin desk.
 *
 * The publisher's copy carries everything needed to do the job without signing
 * in (8 Oct 2026): the brief, a download link for each file the buyer sent, and
 * a signed link to a page where one press confirms receipt and, later, the live
 * URL is submitted. The admin copy gets the same brief and downloads.
 */
export async function sendNewOrderEmails(input: {
  orderId: number;
  domain: string;
  contentType?: string;
  buyerName?: string;
  publisherEmail: string;
  payoutCents: number;
  turnaroundDays: number;
  dueAt?: Date | null;
  targetUrl?: string | null;
  anchorText?: string | null;
  notes?: string | null;
  /** The publisher's no-sign-in page, or null for sites with no publisher account. */
  deskUrl: string | null;
  docName: string | null;
  /** Signed download links. Built by lib/order-steps.ts, never here. */
  publisherFiles: OrderFileLinks;
  adminFiles: OrderFileLinks;
}) {
  const { publisherEmail, domain, orderId } = input;
  const kind = input.contentType === "pr_article" ? "PR article" : "guest post";
  const brief = briefRows(input);
  const deadline = input.dueAt
    ? `Please publish within <strong>${input.turnaroundDays} days</strong>, by <strong>${longDate(input.dueAt)}</strong>.`
    : "";

  const downloads = (f: OrderFileLinks) => {
    const lines: string[] = [];
    if (f.doc) lines.push(downloadLine(f.doc, `Download the article (${input.docName || "document"})`));
    if (f.image) lines.push(downloadLine(f.image, "Download the featured image"));
    if (f.text) lines.push(downloadLine(f.text, "Download the article text the buyer pasted (.txt)"));
    return lines.length
      ? `<p style="line-height:2">${lines.join("<br>")}</p>`
      : `<p style="color:rgba(255,255,255,.6)">The buyer did not attach a file. Everything they sent is in the brief above.</p>`;
  };

  let publisherBody: string;
  if (input.deskUrl) {
    const desk = input.deskUrl;
    publisherBody = `<p>You have a new order (#${orderId}) for a <strong>${kind}</strong> on <strong>${esc(domain)}</strong>.
          Your payout is <strong>${money(input.payoutCents)}</strong>. ${deadline}</p>
       ${brief}
       ${downloads(input.publisherFiles)}
       <p>Please confirm you have received this order. It opens a page for this order and takes one press. No sign-in needed.</p>
       ${button(desk, "Confirm receipt")}
       ${fullLink(desk)}
       <p>When the article is published, open the same link and paste the live URL. The buyer and our team are told straight away.</p>
       <p style="color:rgba(255,255,255,.6);font-size:13px">This link is for you only and works for 30 days. Anyone holding it can act on this order, so please do not forward it. You can also do all of this from <strong>Orders</strong> when signed in.</p>`;
  } else {
    publisherBody = `<p>You have received a new order (#${orderId}) for a <strong>${kind}</strong> on <strong>${esc(domain)}</strong>.</p>
       <p>Sign in to your dashboard, open <strong>Orders</strong>, confirm you received it, then publish the link and submit the live URL.</p>`;
  }
  await send(publisherEmail, `New order on ${domain}`, wrap("You have a new order", publisherBody));

  await send(
    ADMIN_NOTIFY,
    `New order #${orderId} on ${domain}`,
    wrap(
      "New order placed",
      `<p>A new ${kind} order (#${orderId}) was placed on <strong>${esc(domain)}</strong>${
        input.buyerName ? ` by ${esc(input.buyerName)}` : ""
      }.</p>
       ${brief}
       ${downloads(input.adminFiles)}
       ${button(orderPageUrl(orderId), "Open the order")}
       <p style="color:rgba(255,255,255,.6);font-size:13px">The publisher has been emailed a link to confirm receipt and submit the live URL without signing in.</p>`
    )
  );
}

/** The publisher submitted the live URL -> the buyer, with the link to check. */
export function sendLiveUrlBuyer(input: { to: string; orderId: number; domain: string; liveUrl: string }) {
  const live = safeHttpUrl(input.liveUrl);
  return send(
    input.to,
    `Your link is live on ${input.domain} (order #${input.orderId})`,
    wrap(
      "Your link is live",
      `<p>The publisher has published your article on <strong>${esc(input.domain)}</strong> for order
          <strong>#${input.orderId}</strong>. Here is the live page:</p>
       <p>${live ? `<a href="${esc(live)}" style="color:#0aa865;font-weight:600;word-break:break-all">${esc(live)}</a>` : esc(input.liveUrl)}</p>
       <p>Please check it, then confirm on your order page so we can complete the order and pay the publisher.</p>
       ${button(orderPageUrl(input.orderId), "Check and confirm")}
       ${fullLink(orderPageUrl(input.orderId))}`
    )
  );
}

/**
 * Buyer confirmed the link is live -> tell the publisher and the admin desk.
 * This is the moment the 72-hour payment clock starts, so both sides need it:
 * the publisher to know payment is coming, the admin to know to release it.
 */
export async function sendOrderConfirmedEmails(input: {
  publisherEmail: string;
  domain: string;
  orderId: number;
  payoutCents: number;
}) {
  const { publisherEmail, domain, orderId, payoutCents } = input;
  await send(
    publisherEmail,
    `Buyer confirmed order #${orderId} - ready to withdraw`,
    wrap(
      "Your link was confirmed",
      `<p>The buyer has confirmed that your link on <strong>${esc(domain)}</strong> is live, and order
          <strong>#${orderId}</strong> is now complete.</p>
       <p>Your payment of <strong>${money(payoutCents)}</strong> is now ready to withdraw. Sign in
          and press <strong>Withdraw</strong> on your dashboard, confirm your payment details, and
          we will pay you within <strong>72 hours</strong>.</p>`
    )
  );
  await send(
    ADMIN_NOTIFY,
    `Order #${orderId} confirmed (${domain}) - publisher can now withdraw`,
    wrap(
      "Order confirmed",
      `<p>The buyer confirmed order <strong>#${orderId}</strong> on <strong>${esc(domain)}</strong> is live.</p>
       <p>Publisher payout: <strong>${money(payoutCents)}</strong>.</p>
       <p>This is now ready for the publisher to withdraw. You will get a separate email when they
          ask, and you pay it from the admin Withdrawals page.</p>`
    )
  );
}

/** A buyer asked us to list a publisher they negotiated -> admin review needed. */
export function sendSiteRequestAdmin(input: {
  requestId: number;
  buyerName: string;
  buyerEmail: string;
  siteName: string;
  domain: string;
  negotiatedCents: number;
  vatPercent: number;
}) {
  return send(
    ADMIN_NOTIFY,
    `Site request: ${input.domain} (from ${input.buyerName})`,
    wrap(
      "New site request to review",
      `<p><strong>${esc(input.buyerName)}</strong> (${esc(input.buyerEmail)}) has asked us to list a
          publisher they negotiated with.</p>
       <p><strong>Site:</strong> ${esc(input.siteName)}<br>
          <strong>Domain:</strong> ${esc(input.domain)}<br>
          <strong>Negotiated price:</strong> ${money(input.negotiatedCents)}<br>
          <strong>VAT:</strong> ${input.vatPercent > 0 ? input.vatPercent + "%" : "none"}</p>
       <p>Approve or reject it on the admin <strong>Site requests</strong> page. Approving lists it
          immediately: this buyer will see the rate they negotiated, and every other buyer will see
          the standard margin. If we already list this domain, it is created at standard pricing for
          everyone.</p>`
    )
  );
}

/** Tell the buyer whether their requested site was listed. */
export function sendSiteRequestDecision(input: {
  to: string;
  approved: boolean;
  domain: string;
  listingId?: number;
  note?: string;
}) {
  if (input.approved) {
    return send(
      input.to,
      `${input.domain} is now listed`,
      wrap(
        "Your requested site is live",
        `<p><strong>${esc(input.domain)}</strong> has been reviewed and added to the marketplace.</p>
         <p>You can order a placement on it now.</p>`
      )
    );
  }
  return send(
    input.to,
    `About your request for ${input.domain}`,
    wrap(
      "We could not list that site",
      `<p>Thank you for sending us <strong>${esc(input.domain)}</strong>. After review we are not able
          to add it to the marketplace at this time.</p>
       ${input.note ? `<p><strong>Reason:</strong><br>${esc(input.note)}</p>` : ""}
       <p>You are welcome to send us other publishers you have negotiated with.</p>`
    )
  );
}

/** A new buyer registered -> let the admin desk know. */
export function sendBuyerSignupAdmin(name: string, email: string, usersLink: string) {
  return send(
    ADMIN_NOTIFY,
    "New buyer waiting for approval",
    wrap(
      "New buyer waiting for approval",
      `<p>A new buyer signed up and confirmed their email. They cannot sign in until an admin approves them.</p>
       <p><strong>Name:</strong> ${esc(name)}<br><strong>Email:</strong> ${esc(email)}</p>
       ${button(usersLink, "Review buyer approvals")}
       ${fullLink(usersLink)}`
    )
  );
}

/** An admin approved a buyer -> tell them they can sign in now. */
export function sendBuyerApproved(to: string, name: string, loginLink: string) {
  return send(
    to,
    "Your Link Tomorrow account is approved",
    wrap(
      "Your account is approved",
      `<p>Hi ${esc(name)},</p>
       <p>Thanks for waiting. The Welcome Tomorrow team has approved your buyer account on Link Tomorrow, so you can sign in now.</p>
       ${button(loginLink, "Sign in")}
       ${fullLink(loginLink)}`
    )
  );
}

/** A publisher accepted their invite -> welcome them. */
export function sendPublisherWelcome(to: string, name: string) {
  return send(
    to,
    "Your publisher account is ready - Link Tomorrow",
    wrap(
      "Welcome aboard",
      `<p>Hi ${esc(name)}, your publisher account is active.</p>
       <p>Add the websites you want to list, then set your payment details so we can pay you.</p>
       <p>Payment for each order is released within <strong>72 hours</strong> of the buyer confirming your link is live.</p>`
    )
  );
}

/** A publisher joined -> notify the admin desk. */
export function sendPublisherSignupAdmin(name: string, email: string) {
  return send(
    ADMIN_NOTIFY,
    "New publisher joined",
    wrap(
      "New publisher account",
      `<p>A publisher accepted their invite and created an account:</p>
       <p><strong>Name:</strong> ${esc(name)}<br><strong>Email:</strong> ${esc(email)}</p>`
    )
  );
}

/** A new admin joined -> notify the admin desk so it is never a surprise. */
export function sendAdminSignupAdmin(name: string, email: string) {
  return send(
    ADMIN_NOTIFY,
    "New admin account created",
    wrap(
      "New admin account",
      `<p>A new <strong>admin</strong> account was created from an admin invite link:</p>
       <p><strong>Name:</strong> ${esc(name)}<br><strong>Email:</strong> ${esc(email)}</p>
       <p>If you did not expect this, revoke the invite and remove the account immediately.</p>`
    )
  );
}

/** Invite someone to become an admin. */
export function sendAdminInviteEmail(to: string, link: string) {
  return send(
    to,
    "You've been invited as an admin on Link Tomorrow",
    wrap(
      "You're invited as an admin",
      `<p>You've been given admin access to the Link Tomorrow marketplace.</p>
       <p><a href="${link}" style="display:inline-block;background:#0aa865;color:#fff;padding:14px 28px;border-radius:30px;text-decoration:none;font-weight:700">Set up your admin account</a></p>
       <p style="color:rgba(255,255,255,.6)">This link expires in 7 days. Do not forward it - anyone who opens it gets full admin access.</p>`
    )
  );
}

/** Publisher (or the buyer, on a requested site) submitted a live URL -> notify the admin desk. */
export function sendLiveUrlAdmin(orderId: number, domain: string, liveUrl: string, byBuyer = false) {
  const live = safeHttpUrl(liveUrl);
  return send(
    ADMIN_NOTIFY,
    `Link went live on ${domain} (order #${orderId})`,
    wrap(
      "A link just went live",
      `<p>The live URL for order <strong>#${orderId}</strong> on <strong>${esc(domain)}</strong> is in:</p>
       <p>${live ? `<a href="${esc(live)}" style="color:#0aa865;font-weight:600;word-break:break-all">${esc(live)}</a>` : esc(liveUrl)}</p>
       <p>${
         byBuyer
           ? "The buyer arranged this site themselves and has confirmed the placement, so the order is complete. Pay the publisher within 72 hours."
           : "The buyer has been emailed the link and asked to confirm. Once complete, the publisher can withdraw."
       }</p>
       ${button(orderPageUrl(orderId), "Open the order")}`
    )
  );
}

/** A buyer deposit cleared -> notify the admin desk (the buyer gets their own receipt). */
export function sendDepositAdmin(buyerEmail: string, grossCents: number, netCents: number) {
  return send(
    ADMIN_NOTIFY,
    "New deposit received",
    wrap(
      "New deposit",
      `<p>A buyer topped up their wallet:</p>
       <p><strong>Buyer:</strong> ${esc(buyerEmail)}<br>
          <strong>Deposited:</strong> ${money(grossCents)}<br>
          <strong>Credited after the 5% service fee:</strong> ${money(netCents)}</p>
       <p>Remember to send their invoice within 24 hours.</p>`
    )
  );
}

/** Publisher payout approved -> tell the publisher. */
export function sendPublisherPaid(to: string, orderId: number, domain: string) {
  return send(
    to,
    `Payment approved for order #${orderId}`,
    wrap(
      "Your payment has been approved",
      `<p>Your payment for order <strong>#${orderId}</strong> on <strong>${esc(domain)}</strong> has been approved.</p>
       <p>It will be sent to your saved payment details within <strong>72 hours</strong>.</p>
       <p>If anything looks wrong, reply to this email and we will sort it out.</p>`
    )
  );
}

/** A one-off test message, so an admin can prove email works without a payment. */
export function sendTestEmail() {
  return send(
    ADMIN_NOTIFY,
    "Link Tomorrow test email",
    wrap(
      "Email is working",
      `<p>This is a test message sent from the admin dashboard.</p>
       <p>If you are reading this, the sending key and domain are set up correctly, and every
          notification - deposits, orders, signups and confirmation codes - will reach you the
          same way.</p>
       <p style="color:rgba(255,255,255,.6)">Sent ${new Date().toUTCString()}</p>`
    )
  );
}

/** Applicant was rejected -> tell them, with an optional note from the admin. */
export function sendApplicationRejected(to: string, note: string) {
  return send(
    to,
    "Update on your publisher request - Welcome Tomorrow",
    wrap(
      "About your publisher request",
      `<p>Thank you for your interest in listing on the Welcome Tomorrow marketplace.</p>
       <p>After review, we are unable to approve your website(s) at this time.</p>
       ${note ? `<p><strong>Note from our team:</strong><br>${esc(note)}</p>` : ""}
       <p>You are welcome to apply again in the future as your site grows.</p>`
    )
  );
}

/** Someone requested to be listed as a publisher -> notify the admin desk. */
export function sendPublisherApplicationAdmin(input: { name: string; email: string; urls: string }) {
  return send(
    ADMIN_NOTIFY,
    `Publisher request from ${input.name}`,
    wrap(
      "New publisher request",
      `<p>A new publisher has requested to be listed:</p>
       <p><strong>Name:</strong> ${esc(input.name)}<br><strong>Email:</strong> ${esc(input.email)}</p>
       <p><strong>Websites for review:</strong></p>
       <p>${esc(input.urls)}</p>`
    ),
    input.email
  );
}

/**
 * Tell a publisher how a duplicate-domain conflict was settled - whether their
 * price replaced the one we were showing, or we stayed with the existing one.
 */
export function sendListingConflictDecision(input: {
  to: string;
  domain: string;
  kept: boolean; // true = their listing is now the live one
  theirPriceCents: number;
  livePriceCents: number | null;
}) {
  if (input.kept) {
    return send(
      input.to,
      `${input.domain} is now live on Link Tomorrow`,
      wrap(
        "Your listing is live",
        `<p><strong>${esc(input.domain)}</strong> was already on the marketplace, so our team compared
            the two prices.</p>
         <p>Yours won. <strong>${esc(input.domain)}</strong> is now listed at
            <strong>${money(input.theirPriceCents)}</strong> and is available to buyers.</p>`
      )
    );
  }
  return send(
    input.to,
    `We already list ${input.domain}`,
    wrap(
      "We are keeping the current listing",
      `<p>Thank you for submitting <strong>${esc(input.domain)}</strong>. It is already on the
          marketplace${input.livePriceCents !== null ? ` at <strong>${money(input.livePriceCents)}</strong>` : ""},
          and after comparing the two we are staying with the existing listing.</p>
       <p>Your price was ${money(input.theirPriceCents)}. If you can improve on the price we are
          currently showing, submit the site again and we will review it.</p>`
    )
  );
}

/**
 * An order was cancelled after it was funded - by the publisher rejecting the
 * guest post, by an admin, or by the turnaround clock running out.
 *
 * All three go out to the buyer, the publisher and the admin desk, because all
 * three parties were expecting a link to appear. The buyer's mail leads with
 * the refund: that is the only thing they need to act on.
 */
export async function sendOrderCancelledEmails(input: {
  buyerEmail?: string | null;
  publisherEmail?: string | null;
  domain: string;
  orderId: number;
  refundedCents: number;
  by: string;
  reason: string;
}) {
  const { buyerEmail, publisherEmail, domain, orderId, refundedCents, by, reason } = input;
  const who =
    by === "publisher" ? "The publisher rejected this guest post"
    : by === "admin" ? "Our team cancelled this order"
    : by === "system" ? "The turnaround time ran out"
    : "This order was cancelled";

  if (buyerEmail) {
    await send(
      buyerEmail,
      `Order #${orderId} cancelled - ${money(refundedCents)} back in your balance`,
      wrap(
        "Your order was cancelled",
        `<p>${who}, so order <strong>#${orderId}</strong> on <strong>${esc(domain)}</strong>
            will not go ahead.</p>
         <p><strong>${money(refundedCents)}</strong> has been returned to your account balance and is
            ready to spend on another placement right away.</p>
         <p><strong>Reason given:</strong> ${esc(reason)}</p>`
      )
    );
  }
  if (publisherEmail) {
    await send(
      publisherEmail,
      `Order #${orderId} on ${domain} was cancelled`,
      wrap(
        "An order was cancelled",
        `<p>Order <strong>#${orderId}</strong> on <strong>${esc(domain)}</strong> has been cancelled
            and the buyer refunded. There is nothing more to do on it.</p>
         <p><strong>Reason given:</strong> ${esc(reason)}</p>`
      )
    );
  }
  await send(
    ADMIN_NOTIFY,
    `Order #${orderId} cancelled by ${by} (${domain})`,
    wrap(
      "Order cancelled",
      `<p>Order <strong>#${orderId}</strong> on <strong>${esc(domain)}</strong> was cancelled by
          <strong>${esc(by)}</strong>.</p>
       <p>Refunded to the buyer's balance: <strong>${money(refundedCents)}</strong>.</p>
       <p><strong>Reason:</strong> ${esc(reason)}</p>`
    )
  );
}

/**
 * The buyer gets the publisher sign-up link to forward on.
 *
 * It goes to the BUYER, not to the publisher directly: the buyer is the one
 * with the relationship, and a cold link from an address the publisher has
 * never seen is a link nobody clicks.
 */
export function sendPublisherLinkToBuyer(input: {
  buyerEmail: string;
  buyerName: string;
  domain: string;
  publisherName?: string | null;
  link: string;
}) {
  const { buyerEmail, buyerName, domain, publisherName, link } = input;
  const who = publisherName ? esc(publisherName) : "your publisher";
  return send(
    buyerEmail,
    `Your sign-up link for ${domain}`,
    wrap(
      "Send this link to your publisher",
      `<p>Hi ${esc(buyerName)},</p>
       <p>We have approved <strong>${esc(domain)}</strong>. Please send the link below to
          ${who}, it sets up their publisher account so they can list the site and be
          paid directly.</p>
       <p><a href="${link}">${link}</a></p>
       <p>The link works once and expires in 30 days. Tell us if you need a fresh one.</p>`
    )
  );
}

/**
 * The publisher's own copy of a buyer-generated sign-up link.
 *
 * The buyer's name leads, because that is the only reason this mail gets
 * opened - the publisher has spoken to them, not to us.
 */
export function sendBuyerTheirPublisherLink(input: {
  buyerEmail: string;
  buyerName: string;
  publisherEmail: string;
  publisherName?: string | null;
  site?: string | null;
  link: string;
}) {
  const { buyerEmail, buyerName, publisherEmail, publisherName, site, link } = input;
  const who = publisherName ? esc(publisherName) : esc(publisherEmail);
  return send(
    buyerEmail,
    `Your publisher link for ${publisherName || publisherEmail}`,
    wrap(
      "Your publisher link",
      `<p>Hi ${esc(buyerName)},</p>
       <p>Here is the sign-up link for ${who}${site ? ` (${esc(site)})` : ""}. We have emailed it to
          them as well, so you only need this if you would rather send it yourself.</p>
       <p><a href="${link}">${link}</a></p>
       <p>The link works once and expires in 30 days. You can cancel it or make a new one from
          Invite publisher in your account.</p>`
    )
  );
}

export function sendPublisherInviteFromBuyer(input: {
  publisherEmail: string;
  publisherName?: string | null;
  buyerName: string;
  site?: string | null;
  link: string;
}) {
  const { publisherEmail, publisherName, buyerName, site, link } = input;
  const greeting = publisherName ? `Hi ${esc(publisherName)},` : "Hello,";
  return send(
    publisherEmail,
    `${buyerName} would like to list ${site ? site : "your website"} on Link Tomorrow`,
    wrap(
      `${esc(buyerName)} invited you`,
      `<p>${greeting}</p>
       <p><strong>${esc(buyerName)}</strong> buys guest posts and backlinks through Link Tomorrow, and
          asked us to set you up so they can order${site ? ` on ${esc(site)}` : ""} through the platform.</p>
       <p>Use the link below to create your publisher account and list your websites.</p>
       <p><a href="${link}">${link}</a></p>
       <p>It works once and expires in 30 days.</p>`
    )
  );
}

/**
 * A publisher has asked to be paid by something other than PayPal.
 *
 * Whether we can actually pay that way depends on where we bank, not on the
 * platform, so it is a human decision. The publisher has been promised an
 * answer within 24 hours, which is why this goes out the moment they save.
 */
export function sendPayoutMethodRequestAdmin(input: {
  publisherName: string;
  publisherEmail: string;
  method: string;
  details: string;
}) {
  return send(
    ADMIN_NOTIFY,
    `Payout method to review: ${input.publisherName}`,
    wrap(
      "A publisher wants to be paid another way",
      `<p><strong>${esc(input.publisherName)}</strong> (${esc(input.publisherEmail)}) has asked to be
          paid by <strong>${esc(input.method)}</strong> instead of PayPal.</p>
       <p><strong>What they gave us:</strong></p>
       <p>${esc(input.details || "nothing")}</p>
       <p>They have been told they will hear back within 24 hours. Approve or decline it on the
          admin <strong>Payout methods</strong> page.</p>`
    ),
    input.publisherEmail
  );
}

/** The answer to that request, in the publisher's inbox. */
export function sendPayoutMethodDecision(input: {
  to: string;
  approved: boolean;
  method: string;
  note: string;
}) {
  return send(
    input.to,
    input.approved ? "Your payment method is set up" : "About your payment method",
    wrap(
      input.approved ? "You are all set" : "We cannot pay that way",
      input.approved
        ? `<p>We can pay you by <strong>${esc(input.method)}</strong>. Nothing more to do - your
              earnings will go there.</p>
           ${input.note ? `<p>${esc(input.note)}</p>` : ""}`
        : `<p>We are not able to send payments by <strong>${esc(input.method)}</strong>.</p>
           ${input.note ? `<p>${esc(input.note)}</p>` : ""}
           <p>Please open your payment details and choose another method. PayPal is the one we can
              always pay to.</p>`
    )
  );
}

/**
 * A publisher pressed Withdraw. Their details are included so the admin can pay
 * straight from the email, and the admin page is where it gets marked paid.
 */
export function sendWithdrawalRequestAdmin(input: {
  withdrawalId: number;
  publisherName: string;
  publisherEmail: string;
  amountCents: number;
  orderCount: number;
  method: string;
  details: string;
}) {
  return send(
    ADMIN_NOTIFY,
    `ACTION: withdrawal #${input.withdrawalId} - ${money(input.amountCents)} to ${input.publisherName}`,
    wrap(
      "A publisher wants to be paid",
      `<p><strong>${esc(input.publisherName)}</strong> (${esc(input.publisherEmail)}) has asked to
          withdraw <strong>${money(input.amountCents)}</strong> for ${input.orderCount} completed
          order${input.orderCount === 1 ? "" : "s"}.</p>
       <p><strong>Pay by:</strong> ${esc(input.method)}<br>
          <strong>Details:</strong><br>${esc(input.details)}</p>
       <p>They have been told they will be paid within 72 hours. Once the money is sent, approve it
          on the admin <strong>Withdrawals</strong> page, or decline it there with a reason.</p>`
    ),
    input.publisherEmail
  );
}

/** The answer to a withdrawal request, in the publisher's inbox. */
export function sendWithdrawalDecision(input: {
  to: string;
  approved: boolean;
  amountCents: number;
  method: string;
  note: string;
  reference: string;
}) {
  return send(
    input.to,
    input.approved ? `Your withdrawal of ${money(input.amountCents)} has been paid` : "About your withdrawal request",
    wrap(
      input.approved ? "Your withdrawal has been paid" : "We could not pay this withdrawal",
      input.approved
        ? `<p>We have sent <strong>${money(input.amountCents)}</strong> by <strong>${esc(input.method)}</strong>.</p>
           ${input.reference ? `<p><strong>Payment reference:</strong> ${esc(input.reference)}</p>` : ""}
           ${input.note ? `<p>${esc(input.note)}</p>` : ""}
           <p>If it has not arrived within a few days, reply to this email and we will sort it out.</p>`
        : `<p>Your request to withdraw <strong>${money(input.amountCents)}</strong> by
              <strong>${esc(input.method)}</strong> was not approved.</p>
           ${input.note ? `<p><strong>Reason:</strong> ${esc(input.note)}</p>` : ""}
           <p>Your earnings are safe and are available to withdraw again. Sign in, check your
              payment details, and press <strong>Withdraw</strong> on your dashboard.</p>`
    )
  );
}

/**
 * Someone tried to sign up with an address that already has an account. The
 * sign-up screen looks exactly like a new sign-up, so the form cannot be used
 * to test who is registered; the real owner hears about it here instead.
 */
export function sendExistingAccountNotice(to: string, loginUrl: string, forgotUrl: string) {
  return send(
    to,
    "You already have a Link Tomorrow account",
    wrap(
      "You already have an account",
      `<p>Someone, probably you, tried to create a Link Tomorrow account with this email address.
          You already have one.</p>
       <p><a href="${esc(loginUrl)}">Sign in</a>, or if you have forgotten your password,
          <a href="${esc(forgotUrl)}">reset it here</a>.</p>
       <p>If this was not you, you can ignore this email. Nothing has changed on your account.</p>`
    )
  );
}
