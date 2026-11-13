import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { authActionTokensTable } from "@workspace/db";
import { db } from "@workspace/db";

export type AuthActionPurpose = "verify_email" | "reset_password";

const actionPath: Record<AuthActionPurpose, string> = {
  verify_email: "/verify-email",
  reset_password: "/reset-password",
};

export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createAuthActionLink(userId: string, purpose: AuthActionPurpose, lifetimeMinutes: number) {
  const now = new Date();
  await db.update(authActionTokensTable).set({ consumedAt: now })
    .where(and(eq(authActionTokensTable.userId, userId), eq(authActionTokensTable.purpose, purpose)));
  const token = randomBytes(32).toString("base64url");
  await db.insert(authActionTokensTable).values({
    userId,
    purpose,
    tokenHash: hashAuthToken(token),
    expiresAt: new Date(now.getTime() + lifetimeMinutes * 60_000),
  });
  const webUrl = (process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, "");
  return `${webUrl}${actionPath[purpose]}?token=${encodeURIComponent(token)}`;
}

export async function sendAuthActionEmail(email: string, name: string, purpose: AuthActionPurpose, url: string): Promise<boolean> {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.AUTH_FROM_EMAIL?.trim() || user;
  if (!user || !pass || !from) return false;
  const port = Number(process.env.SMTP_PORT || "465");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE.toLowerCase() === "true" : port === 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const subject = purpose === "verify_email" ? "Verify your Veyra email" : "Reset your Veyra password";
  const action = purpose === "verify_email" ? "Verify email" : "Choose a new password";
  const expiry = purpose === "verify_email" ? "30 minutes" : "30 minutes";
  await transporter.sendMail({
    from: { name: "Veyra Finance", address: from },
    to: email,
    subject,
    text: `Hi ${name},\n\n${action}: ${url}\n\nThis link expires in ${expiry}. If you did not request this, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(name)},</p><p><a href="${escapeHtml(url)}">${action}</a></p><p>This link expires in ${expiry}. If you did not request this, you can ignore this email.</p>`,
  });
  return true;
}

export async function sendInvoiceEmail(input: {
  email: string;
  recipientName: string;
  businessName: string;
  invoiceNumber: string;
  description: string;
  lineItems: Array<{ description: string; amount: string }>;
  amount: string;
  currency: string;
  dueDate: string | null;
  invoiceUrl: string;
}): Promise<boolean> {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.AUTH_FROM_EMAIL?.trim() || user;
  if (!user || !pass || !from) return false;
  const port = Number(process.env.SMTP_PORT || "465");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE.toLowerCase() === "true" : port === 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const subject = `New invoice in Veyra from ${input.businessName}`;
  const due = input.dueDate ? `Due date: ${input.dueDate}\n` : "";
  await transporter.sendMail({
    from: { name: input.businessName, address: from },
    to: input.email,
    subject,
    text: `Hi ${input.recipientName},\n\nYou received invoice ${input.invoiceNumber} from ${input.businessName} in Veyra.\n\n${input.description}\n\nAmount due: ${input.currency} ${input.amount}\n${due}\nThis email is a notification. Review the invoice and payment options in your Veyra dashboard: ${input.invoiceUrl}\n\nIf you were not expecting this invoice, you can contact the sender before paying.`,
    html: `<p>Hi ${escapeHtml(input.recipientName)},</p><p>You received invoice <b>${escapeHtml(input.invoiceNumber)}</b> from <b>${escapeHtml(input.businessName)}</b> in Veyra.</p><p>${escapeHtml(input.description)}</p><p><b>Amount due:</b> ${escapeHtml(input.currency)} ${escapeHtml(input.amount)}${input.dueDate ? `<br><b>Due date:</b> ${escapeHtml(input.dueDate)}` : ""}</p><p>This email is a notification. Review the invoice and payment options in your Veyra dashboard.</p><p><a href="${escapeHtml(input.invoiceUrl)}">Open received invoices</a></p><p>If you were not expecting this invoice, contact the sender before paying.</p>`,
  });
  return true;
}

export async function sendInvoicePaymentEmail(input: {
  email: string;
  recipientName: string;
  businessName: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  remainingAmount: string;
  invoiceUrl: string;
}): Promise<boolean> {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.AUTH_FROM_EMAIL?.trim() || user;
  if (!user || !pass || !from) return false;
  const port = Number(process.env.SMTP_PORT || "465");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE.toLowerCase() === "true" : port === 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const subject = `Payment received for invoice ${input.invoiceNumber}`;
  const remaining = Number(input.remainingAmount) > 0 ? `Remaining balance: ${input.currency} ${input.remainingAmount}.` : "This invoice is fully paid.";
  await transporter.sendMail({
    from: { name: "Veyra Finance", address: from },
    to: input.email,
    subject,
    text: `Hi ${input.recipientName},\n\n${input.businessName} received a provider-confirmed payment of ${input.currency} ${input.amount} for invoice ${input.invoiceNumber}. ${remaining}\n\nSee the invoice and payment activity in Veyra: ${input.invoiceUrl}`,
    html: `<p>Hi ${escapeHtml(input.recipientName)},</p><p><b>${escapeHtml(input.businessName)}</b> received a provider-confirmed payment of <b>${escapeHtml(input.currency)} ${escapeHtml(input.amount)}</b> for invoice <b>${escapeHtml(input.invoiceNumber)}</b>.</p><p>${escapeHtml(remaining)}</p><p><a href="${escapeHtml(input.invoiceUrl)}">View invoice and payment activity</a></p>`,
  });
  return true;
}

export async function sendInvoiceReminderEmail(input: {
  email: string;
  recipientName: string;
  businessName: string;
  invoiceNumber: string;
  description: string;
  amountDue: string;
  currency: string;
  dueDate: string | null;
  invoiceUrl: string;
}): Promise<boolean> {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.AUTH_FROM_EMAIL?.trim() || user;
  if (!user || !pass || !from) return false;
  const port = Number(process.env.SMTP_PORT || "465");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE.toLowerCase() === "true" : port === 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const subject = `Reminder: invoice ${input.invoiceNumber} is awaiting payment`;
  const due = input.dueDate ? `Due date: ${input.dueDate}\n` : "";
  await transporter.sendMail({
    from: { name: input.businessName, address: from },
    to: input.email,
    subject,
    text: `Hi ${input.recipientName},\n\nThis is a reminder that invoice ${input.invoiceNumber} from ${input.businessName} has an outstanding balance.\n\n${input.description}\nAmount remaining: ${input.currency} ${input.amountDue}\n${due}\nReview the invoice and payment activity in Veyra: ${input.invoiceUrl}\n\nIf you have already paid, the provider may still be confirming settlement.`,
    html: `<p>Hi ${escapeHtml(input.recipientName)},</p><p>This is a reminder that invoice <b>${escapeHtml(input.invoiceNumber)}</b> from <b>${escapeHtml(input.businessName)}</b> has an outstanding balance.</p><p>${escapeHtml(input.description)}</p><p><b>Amount remaining:</b> ${escapeHtml(input.currency)} ${escapeHtml(input.amountDue)}${input.dueDate ? `<br><b>Due date:</b> ${escapeHtml(input.dueDate)}` : ""}</p><p><a href="${escapeHtml(input.invoiceUrl)}">Review invoice and payment activity in Veyra</a></p><p>If you have already paid, the provider may still be confirming settlement.</p>`,
  });
  return true;
}

export async function sendEmployeeInvitationEmail(input: { email: string; employeeName: string; workspaceName: string; invitationUrl: string }): Promise<boolean> {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.AUTH_FROM_EMAIL?.trim() || user;
  if (!user || !pass || !from) return false;
  const port = Number(process.env.SMTP_PORT || "465");
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com", port, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE.toLowerCase() === "true" : port === 465, auth: { user, pass }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
  await transporter.sendMail({
    from: { name: input.workspaceName, address: from }, to: input.email, subject: `Join ${input.workspaceName} on Veyra`,
    text: `Hi ${input.employeeName},\n\n${input.workspaceName} invited you to join its Veyra team. Sign in or create your Veyra account, then choose your payout asset and wallet. Your employer can add you to payroll after your profile is complete.\n\nAccept invitation: ${input.invitationUrl}\n\nThis invitation expires in seven days.`,
    html: `<p>Hi ${escapeHtml(input.employeeName)},</p><p><b>${escapeHtml(input.workspaceName)}</b> invited you to join its team on Veyra.</p><p>Sign in or create your Veyra account, then choose your payout asset and wallet. Your employer can add you to payroll after your profile is complete.</p><p><a href="${escapeHtml(input.invitationUrl)}">Accept team invitation</a></p><p>This invitation expires in seven days.</p>`,
  });
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function canExposeLocalActionLink(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function emailDeliveryConfigured(): boolean {
  return Boolean(process.env.SMTP_USER?.trim() && process.env.SMTP_PASS?.trim());
}
