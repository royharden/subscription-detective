// Template cancellation drafts used in the browser when the draft-cancellation Edge
// Function can't be used (daily demo limit reached, or Supabase not configured).
// Mirrors mockDraft() in supabase/functions/draft-cancellation.
import { formatCents } from './detection';

export interface TemplateDraftInput {
  merchant: string;
  priceCents: number;
  cadence: string;
  lastChargeDate: string;
  tone: 'polite' | 'firm' | 'refund';
}

export function templateDraft(input: TemplateDraftInput): { subject: string; body: string } {
  const price = formatCents(input.priceCents);
  const merchant = input.merchant;
  if (input.tone === 'firm') {
    return {
      subject: `Cancel my ${merchant} subscription immediately - account [Account or order ID]`,
      body: `Hello ${merchant} team,

I am canceling my ${input.cadence} subscription (account [Account or order ID]) effective immediately. Do not renew it.

The most recent charge was ${price} on ${input.lastChargeDate}. I want confirmation in writing that:
1. The subscription is canceled and will not renew.
2. No further charges will be made to my payment method.

If any charge occurs after this date, I will dispute it.

[Your name]
[Account email]`,
    };
  }
  if (input.tone === 'refund') {
    return {
      subject: `Cancellation and refund request for ${merchant} - [Account or order ID]`,
      body: `Hello ${merchant} support,

I would like to cancel my ${merchant} ${input.cadence} subscription (account [Account or order ID]) and request a refund for the latest charge of ${price} on ${input.lastChargeDate}. I do not intend to use the service going forward.

Please confirm the cancellation and the refund to [Account email].

Thank you,
[Your name]`,
    };
  }
  return {
    subject: `Request to cancel my ${merchant} subscription`,
    body: `Hello ${merchant} team,

I would like to cancel my ${input.cadence} subscription (account [Account or order ID]). The most recent charge was ${price} on ${input.lastChargeDate}.

Could you please confirm the cancellation and that no further charges will be made? You can reach me at [Account email].

Thank you for your help,
[Your name]`,
  };
}
