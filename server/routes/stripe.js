const express = require('express');
const router = express.Router();
const { supabaseAdmin, isSupabaseEnabled } = require('../lib/supabase');

// Initialize Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ============================================================
// POST /api/stripe/create-invoice
// Creates a Stripe Invoice for a client after a successful appeal
// Body: { client_id, appeal_id, amount, description }
// ============================================================
router.post('/create-invoice', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Database not configured' });
    try {
        const { client_id, appeal_id, amount, description } = req.body;
        if (!client_id || !amount) {
            return res.status(400).json({ error: 'client_id and amount required' });
        }

        // Get client info from Supabase
        const { data: client, error: clientErr } = await supabaseAdmin
            .from('clients')
            .select('*')
            .eq('id', client_id)
            .single();
        if (clientErr) throw clientErr;
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Find or create Stripe customer
        let stripeCustomerId = client.stripe_customer_id;
        if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
                name: client.name,
                email: client.email,
                phone: client.phone || undefined,
                metadata: {
                    supabase_client_id: client_id,
                    source: 'overassessed.ai'
                }
            });
            stripeCustomerId = customer.id;

            // Save Stripe customer ID back to Supabase
            await supabaseAdmin
                .from('clients')
                .update({ stripe_customer_id: stripeCustomerId })
                .eq('id', client_id);
        }

        // Create invoice
        const invoice = await stripe.invoices.create({
            customer: stripeCustomerId,
            collection_method: 'send_invoice',
            days_until_due: 30,
            metadata: {
                client_id,
                appeal_id: appeal_id || '',
                source: 'overassessed.ai'
            }
        });

        // Add line item
        await stripe.invoiceItems.create({
            customer: stripeCustomerId,
            invoice: invoice.id,
            amount: Math.round(amount * 100), // Convert dollars to cents
            currency: 'usd',
            description: description || 'Property Tax Appeal - Contingency Fee (percentage of verified tax savings)'
        });

        // Finalize and send the invoice
        const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
        await stripe.invoices.sendInvoice(invoice.id);

        // Record payment in Supabase
        await supabaseAdmin
            .from('payments')
            .insert({
                client_id,
                appeal_id: appeal_id || null,
                stripe_payment_id: invoice.id,
                amount,
                status: 'invoiced'
            });

        res.json({
            success: true,
            invoice_id: invoice.id,
            invoice_url: finalizedInvoice.hosted_invoice_url,
            invoice_pdf: finalizedInvoice.invoice_pdf,
            amount,
            status: 'sent'
        });
    } catch (err) {
        console.error('[Stripe] Invoice creation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// POST /api/stripe/create-checkout
// Creates a Stripe Checkout Session for one-time payment
// Body: { client_id, appeal_id, amount, description, success_url, cancel_url }
// ============================================================
router.post('/create-checkout', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Database not configured' });
    try {
        const { client_id, appeal_id, amount, description, success_url, cancel_url } = req.body;
        if (!client_id || !amount) {
            return res.status(400).json({ error: 'client_id and amount required' });
        }

        // Get client info
        const { data: client, error: clientErr } = await supabaseAdmin
            .from('clients')
            .select('*')
            .eq('id', client_id)
            .single();
        if (clientErr) throw clientErr;
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Find or create Stripe customer
        let stripeCustomerId = client.stripe_customer_id;
        if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
                name: client.name,
                email: client.email,
                phone: client.phone || undefined,
                metadata: {
                    supabase_client_id: client_id,
                    source: 'overassessed.ai'
                }
            });
            stripeCustomerId = customer.id;
            await supabaseAdmin
                .from('clients')
                .update({ stripe_customer_id: stripeCustomerId })
                .eq('id', client_id);
        }

        const baseUrl = process.env.APP_URL || 'https://disciplined-alignment-production.up.railway.app';

        const session = await stripe.checkout.sessions.create({
            customer: stripeCustomerId,
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Property Tax Appeal Fee',
                        description: description || 'Contingency fee - percentage of verified tax savings'
                    },
                    unit_amount: Math.round(amount * 100) // dollars to cents
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: success_url || `${baseUrl}/portal.html?payment=success`,
            cancel_url: cancel_url || `${baseUrl}/portal.html?payment=cancelled`,
            metadata: {
                client_id,
                appeal_id: appeal_id || '',
                source: 'overassessed.ai'
            }
        });

        // Record pending payment
        await supabaseAdmin
            .from('payments')
            .insert({
                client_id,
                appeal_id: appeal_id || null,
                stripe_payment_id: session.id,
                amount,
                status: 'pending'
            });

        res.json({
            success: true,
            checkout_url: session.url,
            session_id: session.id
        });
    } catch (err) {
        console.error('[Stripe] Checkout error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// POST /api/stripe/webhook
// Handles Stripe webhook events (payment confirmations, etc.)
// ============================================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        if (process.env.STRIPE_WEBHOOK_SECRET) {
            event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } else {
            // No webhook secret configured — parse directly (dev mode)
            event = JSON.parse(req.body.toString());
        }
    } catch (err) {
        console.error('[Stripe Webhook] Signature verification failed:', err.message);
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    // Handle events
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            console.log(`[Stripe] Checkout completed: ${session.id}, amount: ${session.amount_total / 100}`);

            if (isSupabaseEnabled()) {
                // Update payment status
                await supabaseAdmin
                    .from('payments')
                    .update({ status: 'paid', stripe_payment_id: session.payment_intent })
                    .eq('stripe_payment_id', session.id);

                // Update appeal payment status if linked
                if (session.metadata?.appeal_id) {
                    await supabaseAdmin
                        .from('appeals')
                        .update({ payment_status: 'paid' })
                        .eq('id', session.metadata.appeal_id);
                }
            }
            break;
        }

        case 'invoice.paid': {
            const invoice = event.data.object;
            console.log(`[Stripe] Invoice paid: ${invoice.id}, amount: ${invoice.amount_paid / 100}`);

            if (isSupabaseEnabled()) {
                await supabaseAdmin
                    .from('payments')
                    .update({ status: 'paid' })
                    .eq('stripe_payment_id', invoice.id);

                if (invoice.metadata?.appeal_id) {
                    await supabaseAdmin
                        .from('appeals')
                        .update({ payment_status: 'paid' })
                        .eq('id', invoice.metadata.appeal_id);
                }
            }
            break;
        }

        case 'invoice.payment_failed': {
            const invoice = event.data.object;
            console.log(`[Stripe] Invoice payment failed: ${invoice.id}`);

            if (isSupabaseEnabled()) {
                await supabaseAdmin
                    .from('payments')
                    .update({ status: 'failed' })
                    .eq('stripe_payment_id', invoice.id);
            }
            break;
        }

        default:
            console.log(`[Stripe] Unhandled event: ${event.type}`);
    }

    res.json({ received: true });
});

// ============================================================
// GET /api/stripe/invoices/:client_id
// List all invoices for a client
// ============================================================
router.get('/invoices/:client_id', async (req, res) => {
    if (!isSupabaseEnabled()) return res.status(503).json({ error: 'Database not configured' });
    try {
        const { data: client, error } = await supabaseAdmin
            .from('clients')
            .select('stripe_customer_id')
            .eq('id', req.params.client_id)
            .single();
        if (error) throw error;
        if (!client?.stripe_customer_id) {
            return res.json([]);
        }

        const invoices = await stripe.invoices.list({
            customer: client.stripe_customer_id,
            limit: 100
        });

        res.json(invoices.data.map(inv => ({
            id: inv.id,
            amount: inv.amount_due / 100,
            status: inv.status,
            invoice_url: inv.hosted_invoice_url,
            invoice_pdf: inv.invoice_pdf,
            created: inv.created,
            due_date: inv.due_date,
            paid: inv.paid
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// POST /api/stripe/setup-intent
// Creates a SetupIntent to collect CC at signup (no charge yet)
// Body: { email, name, phone }
// ============================================================
router.post('/setup-intent', async (req, res) => {
    try {
        const { email, name, phone } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        // Find or create Stripe customer
        const existingCustomers = await stripe.customers.list({ email: email.toLowerCase(), limit: 1 });
        let customer;

        if (existingCustomers.data.length > 0) {
            customer = existingCustomers.data[0];
        } else {
            customer = await stripe.customers.create({
                name: name || undefined,
                email: email.toLowerCase(),
                phone: phone || undefined,
                metadata: { source: 'overassessed.ai' }
            });
        }

        // Create SetupIntent — this authorizes card collection without charging
        const setupIntent = await stripe.setupIntents.create({
            customer: customer.id,
            payment_method_types: ['card'],
            metadata: {
                source: 'overassessed.ai',
                signup_date: new Date().toISOString()
            }
        });

        res.json({
            success: true,
            clientSecret: setupIntent.client_secret,
            customerId: customer.id,
            setupIntentId: setupIntent.id
        });
    } catch (err) {
        console.error('[Stripe] SetupIntent error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// POST /api/stripe/charge-saved-card
// Charges a client's saved card (called by auto-invoice on win)
// Body: { client_id, appeal_id, amount, description }
// ============================================================
router.post('/charge-saved-card', async (req, res) => {
    try {
        const { client_id, appeal_id, amount, description } = req.body;
        if (!client_id || !amount) return res.status(400).json({ error: 'client_id and amount required' });

        const result = await chargeSavedCard(client_id, appeal_id, amount, description);
        if (!result) return res.status(400).json({ error: 'No saved payment method found for client' });

        res.json(result);
    } catch (err) {
        console.error('[Stripe] Charge error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Charge a client's saved card on file.
 * Used by auto-invoicing when appeal is won.
 * Returns payment result or null if no card on file (falls back to invoice).
 */
async function chargeSavedCard(clientId, appealId, amount, description) {
    if (!stripe || !isSupabaseEnabled()) return null;

    // Get client's Stripe customer ID
    const { data: client, error } = await supabaseAdmin
        .from('clients')
        .select('stripe_customer_id, name, email')
        .eq('id', clientId)
        .single();
    if (error || !client?.stripe_customer_id) return null;

    // Get the customer's default payment method
    const customer = await stripe.customers.retrieve(client.stripe_customer_id);
    let paymentMethodId = customer.invoice_settings?.default_payment_method;

    // If no default, try to get the first saved payment method
    if (!paymentMethodId) {
        const methods = await stripe.paymentMethods.list({
            customer: client.stripe_customer_id,
            type: 'card',
            limit: 1
        });
        if (methods.data.length > 0) {
            paymentMethodId = methods.data[0].id;
        }
    }

    if (!paymentMethodId) return null; // No card on file — caller should fall back to invoice

    try {
        // Create and confirm a PaymentIntent (auto-charge)
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // dollars to cents
            currency: 'usd',
            customer: client.stripe_customer_id,
            payment_method: paymentMethodId,
            off_session: true,
            confirm: true,
            description: description || 'Property Tax Appeal Fee — OverAssessed.ai',
            metadata: {
                client_id: clientId,
                appeal_id: appealId || '',
                source: 'overassessed.ai'
            },
            receipt_email: client.email // Auto-send receipt
        });

        // Record in Supabase
        await supabaseAdmin.from('payments').insert({
            client_id: clientId,
            appeal_id: appealId || null,
            stripe_payment_id: paymentIntent.id,
            amount,
            status: paymentIntent.status === 'succeeded' ? 'paid' : 'pending'
        });

        if (appealId) {
            await supabaseAdmin
                .from('appeals')
                .update({ payment_status: 'paid' })
                .eq('id', appealId);
        }

        console.log(`[Stripe] ✅ Auto-charged ${client.email} $${amount} (${paymentIntent.id})`);
        return {
            success: true,
            payment_id: paymentIntent.id,
            amount,
            status: paymentIntent.status,
            method: 'auto_charge',
            email: client.email
        };
    } catch (err) {
        // Card declined or authentication required — fall back to invoice
        console.log(`[Stripe] Auto-charge failed for ${client.email}: ${err.message} — will send invoice instead`);
        return null;
    }
}

module.exports = router;
module.exports.chargeSavedCard = chargeSavedCard;
