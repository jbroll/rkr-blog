// Fail-safe SMTP sender for owner notifications. Mirrors the
// envClassifier() pattern in classify-handler.ts: lazy env read, no
// top-level side effects, never throws, no-ops when unconfigured.

import nodemailer from 'nodemailer';

// Internal (not exported): no external consumer needs the shape;
// the public surface is Mailer / makeMailer / envMailer. Keeping it
// unexported avoids a knip "unused export" until a consumer exists.
// `to` is intentionally absent: the recipient is always cfg.to (NOTIFY_TO
// env), not caller-supplied, so the field would be dead on every call site.
interface MailMessage {
  subject: string;
  text: string;
}
export interface Mailer {
  sendMail(msg: MailMessage): Promise<{ sent: boolean }>;
}
interface SmtpConfig {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
}
type Transport = (msg: MailMessage & { from: string; to: string }) => Promise<void>;

let warned = false;
function warnOnce(m: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`[mailer] ${m}\n`);
}

/** Pure constructor — config + transport injected (testable). */
export function makeMailer(cfg: SmtpConfig, transport: Transport): Mailer {
  return {
    async sendMail(msg) {
      if (!cfg.host || !cfg.to) {
        warnOnce('SMTP_HOST or NOTIFY_TO unset — notifications disabled');
        return { sent: false };
      }
      try {
        await transport({
          ...msg,
          subject: msg.subject.replace(/[\r\n]/g, ''),
          to: cfg.to.replace(/[\r\n]/g, ''),
          from: (cfg.from ?? cfg.user ?? 'rkroll').replace(/[\r\n]/g, '')
        });
        return { sent: true };
      } catch (err) {
        process.stderr.write(`[mailer] send failed: ${(err as Error).message}\n`);
        return { sent: false };
      }
    }
  };
}

/** Env-backed factory (reads process.env at call time, not import). */
export function envMailer(): Mailer {
  const e = process.env;
  const cfg: SmtpConfig = {
    host: e.SMTP_HOST,
    port: e.SMTP_PORT ? Number(e.SMTP_PORT) : 587,
    user: e.SMTP_USER,
    pass: e.SMTP_PASS,
    from: e.SMTP_FROM,
    to: e.NOTIFY_TO
  };
  /* c8 ignore start -- real SMTP I/O; exercised manually, not in the
     unit suite (mirrors the classify-handler default-transport
     ignore). makeMailer's logic + the no-op path are covered. */
  const transport: Transport = async (m) => {
    const t = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass ?? '' } } : {})
    });
    await t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text });
  };
  /* c8 ignore stop */
  return makeMailer(cfg, transport);
}
