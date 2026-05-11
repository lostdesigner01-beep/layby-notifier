const express = require('express');
const crypto = require('crypto');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

function verifyShopifyWebhook(req) {
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    if (!hmac) return false;
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    const body = req.body;
    const hash = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('base64');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
  } catch (e) {
    console.error('Verification error:', e.message);
    return false;
  }
}

async function getConsignorBySku(sku) {
  const ccApiKey = process.env.CONSIGNCLOUD_API_KEY;

  const itemRes = await fetch(
    `https://api.consigncloud.com/api/v1/items?sku=${encodeURIComponent(sku)}&limit=1`,
    { headers: { Authorization: `Bearer ${ccApiKey}` } }
  );

  if (!itemRes.ok) {
    console.error('ConsignCloud items API error:', await itemRes.text());
    return null;
  }

  const itemData = await itemRes.json();
  if (!itemData.data || itemData.data.length === 0) {
    console.log(`No item found in ConsignCloud for SKU: ${sku}`);
    return null;
  }

  const item = itemData.data[0];
  const accountId = item.account;

  if (!accountId) {
    console.log(`Item ${sku} has no account associated`);
    return null;
  }

  const accountRes = await fetch(
    `https://api.consigncloud.com/api/v1/accounts/${accountId}`,
    { headers: { Authorization: `Bearer ${ccApiKey}` } }
  );

  if (!accountRes.ok) {
    console.error('ConsignCloud accounts API error:', await accountRes.text());
    return null;
  }

  const account = await accountRes.json();
  return {
    email: account.email,
    firstName: account.first_name,
    lastName: account.last_name,
    itemTitle: item.title || item.description || sku,
    sku,
  };
}

async function hasBeenEmailedLayby(sku) {
  const { data, error } = await supabase
    .from('emailed_skus')
    .select('sku')
    .eq('sku', sku)
    .single();
  if (error && error.code !== 'PGRST116') console.error('Supabase error:', error);
  return !!data;
}

async function markAsEmailedLayby(sku) {
  const { error } = await supabase.from('emailed_skus').insert({ sku });
  if (error) console.error('Supabase insert error:', error);
}

async function hasBeenEmailedEbay(sku) {
  const { data, error } = await supabase
    .from('emailed_skus_ebay')
    .select('sku')
    .eq('sku', sku)
    .single();
  if (error && error.code !== 'PGRST116') console.error('Supabase error:', error);
  return !!data;
}

async function markAsEmailedEbay(sku) {
  const { error } = await supabase.from('emailed_skus_ebay').insert({ sku });
  if (error) console.error('Supabase insert error:', error);
}

async function sendLayByEmail(consignor, orderName) {
  const { email, firstName, itemTitle, sku } = consignor;
  if (!email) { console.log(`No email for SKU ${sku}`); return false; }
  const name = firstName || 'there';
  try {
    const { data, error } = await resend.emails.send({
      from: 'Lost Designer <enquiries@lostdesigner.com.au>',
      to: email,
      subject: `Your item has been sold on Lay-By!`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; color: #1b1b1b;">
          <div style="background: #1b1b1b; padding: 28px; text-align: center;">
            <img src="https://cdn.shopify.com/s/files/1/0675/5287/0700/files/DESINER_2_2_1.png?v=1778473212" alt="Lost Designer" style="width: 100%; max-width: 420px; display: block; margin: 0 auto;" />
          </div>
          <div style="padding: 40px 30px; background: #f9f6f0;">
            <p style="font-size: 16px; line-height: 1.6;">Hi ${name},</p>
            <p style="font-size: 16px; line-height: 1.6;">
              Great news — your item <strong>${itemTitle}</strong> (SKU: ${sku}) has been sold on our <strong>Lay-By payment plan</strong>.
            </p>
            <div style="background: #fff; border-left: 4px solid #D4AF37; padding: 20px 25px; margin: 25px 0;">
              <p style="margin: 0 0 10px; font-size: 15px; line-height: 1.6; color: #555;">
                <strong>Please note:</strong> You may have received an automated email showing a lower payment amount — this reflects only the <strong>initial Lay-By deposit (20%)</strong>, not the full sale price. Your item has not sold for a reduced amount.
              </p>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #555;">
                The customer pays the remaining balance in fortnightly instalments over 8 weeks, though they may choose to pay it off earlier. Once all payments are complete, your full consignor payout will be processed as normal.
              </p>
            </div>
            <p style="font-size: 16px; line-height: 1.6;">In the meantime, your item will remain securely held in our boutique until the Lay-By is fully paid off.</p>
            <p style="font-size: 16px; line-height: 1.6;">If you have any questions, please don't hesitate to get in touch — we're always happy to help.</p>
            <div style="margin: 8px 0 28px;">
              <p style="font-size: 15px; line-height: 1.9; margin: 0; color: #1b1b1b;">
                enquiries@lostdesigner.com.au<br/>
                (03) 9522 9884<br/>
                428E Toorak Rd, Toorak VIC 3142
              </p>
            </div>
            <p style="font-size: 16px; line-height: 1.6; margin: 0;">Warm regards,<br/><strong>The Lost Designer Team</strong></p>
          </div>
          <div style="background: #1b1b1b; padding: 20px; text-align: center;">
            <p style="color: #888; font-size: 12px; margin: 0;">428E Toorak Rd, Toorak VIC 3142 &nbsp;|&nbsp; lostdesigner.com.au &nbsp;|&nbsp; (03) 9522 9884</p>
          </div>
        </div>
      `,
    });
    if (error) { console.error(`Resend error for SKU ${sku}:`, error); return false; }
    console.log(`Lay-By email sent to ${email} for SKU ${sku}`);
    return true;
  } catch (e) {
    console.error(`Failed to send Lay-By email for SKU ${sku}:`, e.message);
    return false;
  }
}

async function sendEbayEmail(consignor, orderName) {
  const { email, firstName, itemTitle, sku } = consignor;
  if (!email) { console.log(`No email for SKU ${sku}`); return false; }
  const name = firstName || 'there';
  try {
    const { data, error } = await resend.emails.send({
      from: 'Lost Designer <enquiries@lostdesigner.com.au>',
      to: email,
      subject: `Your item has been sold on eBay!`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; color: #1b1b1b;">
          <div style="background: #1b1b1b; padding: 28px; text-align: center;">
            <img src="https://cdn.shopify.com/s/files/1/0675/5287/0700/files/DESINER_2_2_1.png?v=1778473212" alt="Lost Designer" style="width: 100%; max-width: 420px; display: block; margin: 0 auto;" />
          </div>
          <div style="padding: 40px 30px; background: #f9f6f0;">
            <p style="font-size: 16px; line-height: 1.6;">Hi ${name},</p>
            <p style="font-size: 16px; line-height: 1.6;">
              Great news — your item <strong>${itemTitle}</strong> (SKU: ${sku}) has been sold on <strong>eBay</strong>.
            </p>
            <div style="background: #fff; border-left: 4px solid #D4AF37; padding: 20px 25px; margin: 25px 0;">
              <p style="margin: 0 0 10px; font-size: 15px; line-height: 1.6; color: #555;">
                <strong>Please note:</strong> You may notice the sale price appears slightly higher than your agreed listing price. This is because we list items on eBay at a <strong>15% premium</strong> to cover eBay's selling fees, so your consignor payout remains unaffected.
              </p>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #555;">
                Your payout will be calculated based on your original agreed consignment price — not the inflated eBay listing price.
              </p>
            </div>
            <p style="font-size: 16px; line-height: 1.6;">If you have any questions, please don't hesitate to get in touch — we're always happy to help.</p>
            <div style="margin: 8px 0 28px;">
              <p style="font-size: 15px; line-height: 1.9; margin: 0; color: #1b1b1b;">
                enquiries@lostdesigner.com.au<br/>
                (03) 9522 9884<br/>
                428E Toorak Rd, Toorak VIC 3142
              </p>
            </div>
            <p style="font-size: 16px; line-height: 1.6; margin: 0;">Warm regards,<br/><strong>The Lost Designer Team</strong></p>
          </div>
          <div style="background: #1b1b1b; padding: 20px; text-align: center;">
            <p style="color: #888; font-size: 12px; margin: 0;">428E Toorak Rd, Toorak VIC 3142 &nbsp;|&nbsp; lostdesigner.com.au &nbsp;|&nbsp; (03) 9522 9884</p>
          </div>
        </div>
      `,
    });
    if (error) { console.error(`Resend error for SKU ${sku}:`, error); return false; }
    console.log(`eBay email sent to ${email} for SKU ${sku}`);
    return true;
  } catch (e) {
    console.error(`Failed to send eBay email for SKU ${sku}:`, e.message);
    return false;
  }
}

app.post('/webhook/shopify/orders', async (req, res) => {
  console.log('Webhook received');

  if (!verifyShopifyWebhook(req)) {
    console.log('Webhook verification failed - ignoring');
    return res.status(200).send('OK');
  }

  console.log('Webhook verified successfully');

  let order;
  try {
    order = JSON.parse(req.body.toString());
  } catch (e) {
    console.error('Failed to parse order JSON:', e.message);
    return res.status(200).send('OK');
  }

  const tags = (order.tags || '').split(',').map(t => t.trim());
  console.log('Order tags:', tags);

  const isLayby = tags.includes('Lay-By');
  const isEbay = tags.includes('eBay');

  if (!isLayby && !isEbay) {
    console.log('Not a Lay-By or eBay order, skipping');
    return res.status(200).send('OK');
  }

  for (const lineItem of order.line_items || []) {
    const sku = lineItem.sku;
    console.log(`Processing line item SKU: ${sku}`);

    if (!sku) {
      console.log('Line item has no SKU, skipping');
      continue;
    }

    const consignor = await getConsignorBySku(sku);
    if (!consignor) {
      console.log(`Could not find consignor for SKU ${sku}`);
      continue;
    }

    if (isLayby) {
      const alreadyEmailed = await hasBeenEmailedLayby(sku);
      if (alreadyEmailed) {
        console.log(`Already sent Lay-By email for SKU ${sku}, skipping`);
      } else {
        const sent = await sendLayByEmail(consignor, order.name);
        if (sent) await markAsEmailedLayby(sku);
      }
    }

    if (isEbay) {
      const alreadyEmailed = await hasBeenEmailedEbay(sku);
      if (alreadyEmailed) {
        console.log(`Already sent eBay email for SKU ${sku}, skipping`);
      } else {
        const sent = await sendEbayEmail(consignor, order.name);
        if (sent) await markAsEmailedEbay(sku);
      }
    }
  }

  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.send('Lay-By Notifier is running');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
