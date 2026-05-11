const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.zoho.com.au',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

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

async function hasBeenEmailed(sku) {
  const { data, error } = await supabase
    .from('emailed_skus')
    .select('sku')
    .eq('sku', sku)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Supabase select error:', error);
  }

  return !!data;
}

async function markAsEmailed(sku) {
  const { error } = await supabase
    .from('emailed_skus')
    .insert({ sku });

  if (error) {
    console.error('Supabase insert error:', error);
  }
}

async function sendLayByEmail(consignor, orderName) {
  const { email, firstName, itemTitle, sku } = consignor;

  if (!email) {
    console.log(`No email address for consignor of SKU ${sku}, skipping`);
    return false;
  }

  const name = firstName || 'there';

  const mailOptions = {
    from: `"Lost Designer" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Great news — your item has been reserved on Lay-By!`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; color: #1b1b1b;">
        <div style="background: #1b1b1b; padding: 24px; text-align: center;">
          <img src="https://cdn.shopify.com/s/files/1/0675/5287/0700/files/lost_designer_logo_email_2.png?v=1778465268" alt="Lost Designer" style="width: 100%; max-width: 400px; display: block; margin: 0 auto;" />
        </div>
        <div style="padding: 40px 30px; background: #f9f6f0;">
          <p style="font-size: 16px; line-height: 1.6;">Hi ${name},</p>
          <p style="font-size: 16px; line-height: 1.6;">
            Great news — your item <strong>${itemTitle}</strong> (SKU: ${sku}) has been reserved by a customer on our <strong>Lay-By payment plan</strong>.
          </p>
          <div style="background: #fff; border-left: 4px solid #D4AF37; padding: 20px 25px; margin: 25px 0;">
            <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #555;">
              <strong>Please note:</strong> You may have received an automated email showing a lower payment amount — this reflects only the <strong>initial Lay-By deposit (20%)</strong>, not the full sale price. Your item has not sold for a reduced amount.
            </p>
          </div>
          <p style="font-size: 16px; line-height: 1.6;">
            The customer will pay the remaining balance in fortnightly instalments. Once all payments are complete, your full consignor payout will be processed as normal.
          </p>
          <p style="font-size: 16px; line-height: 1.6;">
            If you have any questions, please don't hesitate to reach out — we're always happy to help.
          </p>
          <p style="font-size: 16px; line-height: 1.6; margin-top: 30px;">
            Warm regards,<br/>
            <strong>The Lost Designer Team</strong>
          </p>
        </div>
        <div style="background: #1b1b1b; padding: 20px; text-align: center;">
          <p style="color: #888; font-size: 12px; margin: 0;">
            428E Toorak Rd, Toorak VIC 3142 &nbsp;|&nbsp; lostdesigner.com.au
          </p>
        </div>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
  console.log(`Email sent to ${email} for SKU ${sku}`);
  return true;
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

  if (!tags.includes('Lay-By')) {
    console.log('Not a Lay-By order, skipping');
    return res.status(200).send('OK');
  }

  console.log(`Lay-By order detected: ${order.name}`);

  for (const lineItem of order.line_items || []) {
    const sku = lineItem.sku;
    console.log(`Processing line item SKU: ${sku}`);

    if (!sku) {
      console.log('Line item has no SKU, skipping');
      continue;
    }

    const alreadyEmailed = await hasBeenEmailed(sku);
    if (alreadyEmailed) {
      console.log(`Already emailed for SKU ${sku}, skipping`);
      continue;
    }

    const consignor = await getConsignorBySku(sku);
    if (!consignor) {
      console.log(`Could not find consignor for SKU ${sku}`);
      continue;
    }

    const sent = await sendLayByEmail(consignor, order.name);

    if (sent) {
      await markAsEmailed(sku);
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
