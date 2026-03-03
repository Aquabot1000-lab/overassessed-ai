// OverAssessed JavaScript

// Smooth scroll to intake form
function scrollToIntake() {
    document.getElementById('intake-form').scrollIntoView({
        behavior: 'smooth'
    });
}

// FAQ toggle functionality
function toggleFaq(button) {
    const faqItem = button.parentElement;
    const answer = faqItem.querySelector('.faq-answer');
    const icon = button.querySelector('.faq-icon');
    
    document.querySelectorAll('.faq-item').forEach(item => {
        if (item !== faqItem) {
            item.classList.remove('active');
            item.querySelector('.faq-answer').classList.remove('active');
            item.querySelector('.faq-icon').textContent = '+';
        }
    });
    
    faqItem.classList.toggle('active');
    answer.classList.toggle('active');
    icon.textContent = faqItem.classList.contains('active') ? '×' : '+';
}

// Animated counter for savings
function animateCounter(element, target, duration) {
    const start = 0;
    const startTime = performance.now();
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (target - start) * eased);
        element.textContent = '$' + current.toLocaleString();
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

// Intersection Observer for scroll animations
function initScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -40px 0px'
    });

    document.querySelectorAll('.animate-section .step, .animate-section .service-card, .animate-section .benefit, .animate-section .testimonial, .animate-section .faq-item').forEach(el => {
        observer.observe(el);
    });
}

// Start savings counter when hero is visible
function initSavingsCounter() {
    const counter = document.getElementById('savingsCounter');
    if (!counter) return;
    
    let started = false;
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && !started) {
                started = true;
                animateCounter(counter, 2847, 2000);
            }
        });
    }, { threshold: 0.3 });
    
    observer.observe(counter);
}

// Form handling
document.addEventListener('DOMContentLoaded', function() {
    // Init animations
    initScrollAnimations();
    initSavingsCounter();
    
    // Referral banner
    const refParam = new URLSearchParams(window.location.search).get('ref');
    if (refParam) {
        const banner = document.createElement('div');
        banner.style.cssText = 'background: linear-gradient(135deg, #6c5ce7, #0984e3); color: white; text-align: center; padding: 12px 20px; font-weight: 600; font-size: 0.95rem;';
        banner.textContent = '🎉 You were referred! You\'ll get a reduced rate on your first appeal.';
        document.body.insertBefore(banner, document.body.firstChild);
    }
    
    // Conditional field visibility
    document.getElementById('renovations').addEventListener('change', function() {
        document.getElementById('renovationDescGroup').style.display = this.value.startsWith('Yes') ? '' : 'none';
    });
    document.getElementById('conditionIssues').addEventListener('change', function() {
        document.getElementById('conditionDescGroup').style.display = this.value !== 'No' ? '' : 'none';
    });
    document.getElementById('recentAppraisal').addEventListener('change', function() {
        document.getElementById('appraisalDetailsGroup').style.display = this.value === 'Yes' ? '' : 'none';
    });

    // ==================== STRIPE ELEMENTS SETUP ====================
    let stripeInstance = null;
    let cardElement = null;
    let stripeCustomerId = null;
    let setupIntentClientSecret = null;

    try {
        // Initialize Stripe with publishable key
        stripeInstance = Stripe('pk_live_51T4o1I9Xv7GOUXbE7HQybLNB69XcQYSdV5L5xulEjwxeGbE0NAKbETO0VPuFFFHCC41at69b32bAFMdJSPKHHI4K000hX7PSGC');
        const elements = stripeInstance.elements();
        cardElement = elements.create('card', {
            style: {
                base: {
                    fontSize: '16px',
                    color: '#1a1a2e',
                    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
                    '::placeholder': { color: '#9ca3af' }
                },
                invalid: { color: '#ff6b6b' }
            }
        });
        cardElement.mount('#card-element');
        cardElement.on('change', function(event) {
            const errEl = document.getElementById('card-errors');
            errEl.textContent = event.error ? event.error.message : '';
        });
        console.log('[Stripe] Card element mounted');
    } catch (stripeErr) {
        console.warn('[Stripe] Init failed:', stripeErr.message);
        // Hide card section if Stripe fails to load
        const cardSection = document.getElementById('card-section');
        if (cardSection) cardSection.style.display = 'none';
    }

    const form = document.getElementById('intakeForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const formContainer = document.querySelector('.intake-form');
    const successMessage = document.getElementById('formSuccess');
    
    // Phone number formatting
    const phoneInput = document.getElementById('phone');
    phoneInput.addEventListener('input', function(e) {
        let value = e.target.value.replace(/\D/g, '');
        if (value.length >= 6) {
            value = `(${value.slice(0,3)}) ${value.slice(3,6)}-${value.slice(6,10)}`;
        } else if (value.length >= 3) {
            value = `(${value.slice(0,3)}) ${value.slice(3)}`;
        }
        e.target.value = value;
    });
    
    // Assessed value formatting
    const assessedValueInput = document.getElementById('assessedValue');
    assessedValueInput.addEventListener('input', function(e) {
        let value = e.target.value.replace(/[^\d]/g, '');
        if (value) {
            value = '$' + parseInt(value).toLocaleString();
        }
        e.target.value = value;
    });
    
    // Form submission
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        submitBtn.disabled = true;
        btnText.style.display = 'none';
        btnLoader.style.display = 'inline';
        
        // Ref tracking
        const urlParams = new URLSearchParams(window.location.search);
        const refCode = urlParams.get('ref');

        const formData = {
            propertyAddress: document.getElementById('propertyAddress').value,
            propertyType: document.getElementById('propertyType').value,
            ownerName: document.getElementById('ownerName').value,
            phone: document.getElementById('phone').value,
            email: document.getElementById('email').value,
            assessedValue: document.getElementById('assessedValue').value,
            bedrooms: document.getElementById('bedrooms').value || null,
            bathrooms: document.getElementById('bathrooms').value || null,
            sqft: document.getElementById('sqft').value || null,
            yearBuilt: document.getElementById('yearBuilt').value || null,
            renovations: document.getElementById('renovations').value,
            renovationDesc: document.getElementById('renovationDesc').value || null,
            conditionIssues: document.getElementById('conditionIssues').value,
            conditionDesc: document.getElementById('conditionDesc').value || null,
            recentAppraisal: document.getElementById('recentAppraisal').value,
            appraisedValue: document.getElementById('appraisedValue').value || null,
            appraisalDate: document.getElementById('appraisalDate').value || null,
            notificationPref: document.getElementById('notificationPref').value,
            source: document.getElementById('stateSelect').value === 'GA' ? 'website-ga' : 'website',
            submittedAt: new Date().toISOString(),
            utm_data: JSON.stringify((function(){const p=new URLSearchParams(window.location.search);return{utm_source:p.get('utm_source')||'',utm_medium:p.get('utm_medium')||'',utm_campaign:p.get('utm_campaign')||'',utm_term:p.get('utm_term')||''}})())
        };
        
        if (refCode) formData.ref = refCode;
        
        try {
            // ==================== STRIPE: Save Card on File ====================
            if (stripeInstance && cardElement) {
                try {
                    // Step 1: Create SetupIntent on the server
                    const setupRes = await fetch('/api/stripe/setup-intent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            email: formData.email,
                            name: formData.ownerName,
                            phone: formData.phone
                        })
                    });
                    const setupData = await setupRes.json();

                    if (setupData.success && setupData.clientSecret) {
                        // Step 2: Confirm the SetupIntent with the card details
                        const { setupIntent, error: stripeError } = await stripeInstance.confirmCardSetup(
                            setupData.clientSecret,
                            {
                                payment_method: {
                                    card: cardElement,
                                    billing_details: {
                                        name: formData.ownerName,
                                        email: formData.email,
                                        phone: formData.phone
                                    }
                                }
                            }
                        );

                        if (stripeError) {
                            document.getElementById('card-errors').textContent = stripeError.message;
                            submitBtn.disabled = false;
                            btnText.style.display = 'inline';
                            btnLoader.style.display = 'none';
                            return; // Don't submit form if card fails
                        }

                        // Step 3: Card saved! Pass IDs to backend
                        formData.stripeCustomerId = setupData.customerId;
                        formData.stripePaymentMethodId = setupIntent.payment_method;
                        console.log('[Stripe] Card saved successfully:', setupIntent.payment_method);
                    }
                } catch (stripeErr) {
                    console.warn('[Stripe] Card setup failed:', stripeErr.message);
                    // Continue without card — they'll get invoiced later
                }
            }

            const response = await fetch('/api/intake', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            
            if (response.ok) {
                const result = await response.json();
                formContainer.style.display = 'none';
                successMessage.style.display = 'block';
                
                // Show case ID
                if (result.caseId) {
                    document.getElementById('formSuccess').innerHTML = `
                        <div class="success-icon">✅</div>
                        <h3>Analysis Request Received!</h3>
                        <div style="background: #f8f9ff; border: 2px solid #6c5ce7; border-radius: 12px; padding: 20px; margin: 20px 0; text-align: center;">
                            <p style="margin: 0 0 5px; font-size: 14px; color: #6b7280;">Your Case ID</p>
                            <p style="margin: 0; font-size: 32px; font-weight: 800; color: #6c5ce7;">${result.caseId}</p>
                        </div>
                        <p>Check your email for next steps and your portal login details.</p>
                        <a href="/portal" style="display: inline-block; margin-top: 15px; background: linear-gradient(135deg, #6c5ce7, #0984e3); color: white; padding: 12px 28px; border-radius: 50px; text-decoration: none; font-weight: 700;">Go to Client Portal →</a>
                    `;
                }
                
                if (typeof gtag !== 'undefined') {
                    gtag('event', 'conversion', {
                        'send_to': 'AW-CONVERSION_ID/CONVERSION_LABEL',
                        'value': 1.0,
                        'currency': 'USD'
                    });
                }
            } else {
                throw new Error('Failed to submit form');
            }
        } catch (error) {
            console.error('Form submission error:', error);
            alert('Sorry, there was an error submitting your form. Please try again or call us directly.');
            submitBtn.disabled = false;
            btnText.style.display = 'inline';
            btnLoader.style.display = 'none';
        }
    });
    
    // Mobile menu toggle
    const mobileToggle = document.querySelector('.mobile-menu-toggle');
    const nav = document.querySelector('.nav');
    
    if (mobileToggle) {
        mobileToggle.addEventListener('click', function() {
            nav.classList.toggle('mobile-active');
            // Animate hamburger
            this.classList.toggle('active');
        });
        
        // Close menu on link click
        nav.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                nav.classList.remove('mobile-active');
                mobileToggle.classList.remove('active');
            });
        });
    }
    
    // Smooth scrolling for navigation links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
    
    // Form validation enhancements
    const requiredFields = form.querySelectorAll('[required]');
    requiredFields.forEach(field => {
        field.addEventListener('blur', function() {
            if (!this.value.trim()) {
                this.style.borderColor = '#e53e3e';
            } else {
                this.style.borderColor = '#e2e8f0';
            }
        });
        
        field.addEventListener('input', function() {
            if (this.style.borderColor === 'rgb(229, 62, 62)' && this.value.trim()) {
                this.style.borderColor = '#e2e8f0';
            }
        });
    });
    
    // Email validation
    const emailField = document.getElementById('email');
    emailField.addEventListener('blur', function() {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (this.value && !emailRegex.test(this.value)) {
            this.style.borderColor = '#e53e3e';
        }
    });
    
    // Header shadow on scroll
    const header = document.querySelector('.header');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 10) {
            header.style.boxShadow = '0 4px 20px rgba(0,0,0,0.1)';
        } else {
            header.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
        }
    }, { passive: true });
});

// Utility functions
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

function formatPhoneNumber(phoneNumber) {
    const cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.length === 10) {
        return `(${cleaned.slice(0,3)}) ${cleaned.slice(3,6)}-${cleaned.slice(6)}`;
    }
    return phoneNumber;
}

// Analytics tracking (placeholder)
function trackEvent(eventName, eventData = {}) {
    console.log('Event tracked:', eventName, eventData);
    if (typeof gtag !== 'undefined') gtag('event', eventName, eventData);
    if (typeof fbq !== 'undefined') fbq('track', eventName, eventData);
}

// Service Worker registration for PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js').then(function(registration) {
            console.log('ServiceWorker registration successful');
        }, function(err) {
            console.log('ServiceWorker registration failed: ', err);
        });
    });
}