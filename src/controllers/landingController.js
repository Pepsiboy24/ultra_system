/**
 * Landing Controller
 *
 * Relay marketing site, served as self-contained HTML from the Worker at
 * GET / (mounted at '/'), plus GET /privacy-policy linked from the footer.
 *
 * Rendered in-memory and sent with res.type('html').send(...) — the same
 * approach as invoiceController — so it works on Cloudflare Workers, where
 * express.static() cannot read files from disk.
 *
 * The signup form POSTs to /api/leads (leadController). No WhatsApp account
 * is connected here and no Embedded Signup is implemented — leads are for
 * manual follow-up only.
 */

const express = require('express');
const router = express.Router();

const LOGO_SVG = `
<svg class="logo-mark" width="34" height="34" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
<path d="M4 8a4 4 0 0 1 4-4h20a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H16l-6 6v-6H8a4 4 0 0 1-4-4z" fill="#ffffff"/>
<text x="18" y="24" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="800" fill="#10794E">R</text>
</svg>`;

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Relay — Take WhatsApp orders automatically</title>
<meta name="description" content="Relay turns customer WhatsApp messages into confirmed, priced and invoiced orders for Nigerian wholesalers, restaurants and dropshippers.">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#0B141A;
  --ink-soft:#1F2C34;
  --paper:#F6F6F0;
  --paper-dim:#ECE5DD;
  --signal:#25D366;
  --signal-dim:#1DA851;
  --green:#075E54;
  --green-soft:#DCF8C6;
  --gray:#667781;
  --gray-line: rgba(11,20,26,0.12);
  --paper-line: rgba(246,246,240,0.14);
  --display: 'Archivo', sans-serif;
  --body: 'Inter', sans-serif;
  --mono: 'IBM Plex Mono', monospace;
}

*{margin:0;padding:0;box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{
  background:var(--paper);
  color:var(--ink);
  font-family:var(--body);
  -webkit-font-smoothing:antialiased;
  overflow-x:hidden;
}

@media (prefers-reduced-motion: reduce){
  *{animation-duration:0.01ms !important; animation-iteration-count:1 !important; transition-duration:0.01ms !important;}
}

a{color:inherit; text-decoration:none;}
button{font-family:inherit; cursor:pointer;}

:focus-visible{
  outline:3px solid var(--signal);
  outline-offset:3px;
}

.wrap{
  max-width:1180px;
  margin:0 auto;
  padding:0 32px;
}

/* ============ NAV ============ */
.nav{
  position:fixed;
  top:0; left:0; right:0;
  z-index:100;
  background:rgba(247,243,236,0.88);
  backdrop-filter:blur(10px);
  border-bottom:1px solid var(--gray-line);
}
.nav-inner{
  max-width:1180px;
  margin:0 auto;
  padding:18px 32px;
  display:flex;
  align-items:center;
  justify-content:space-between;
}
.logo{
  font-family:var(--display);
  font-weight:800;
  font-size:22px;
  letter-spacing:-0.02em;
  display:flex;
  align-items:center;
  gap:8px;
}
.logo-mark{
  width:10px;height:10px;
  background:var(--signal);
  border-radius:2px;
  display:inline-block;
  transform:rotate(45deg);
}
.nav-links{
  display:flex;
  gap:36px;
  font-size:15px;
  font-weight:500;
}
.nav-links a{opacity:0.75; transition:opacity 0.15s;}
.nav-links a:hover{opacity:1;}
.nav-cta{
  background:var(--ink);
  color:var(--paper);
  padding:10px 20px;
  border-radius:6px;
  font-weight:600;
  font-size:14px;
  border:none;
  transition:transform 0.15s ease, background 0.15s ease;
}
.nav-cta:hover{background:var(--signal); transform:translateY(-1px);}
.nav-mobile-toggle{display:none;}

@media (max-width:860px){
  .nav-links{display:none;}
  .nav-inner{padding:16px 20px;}
}

/* ============ HERO ============ */
.hero{
  padding:150px 0 90px;
  position:relative;
}
.hero-grid{
  display:grid;
  grid-template-columns:1.05fr 0.95fr;
  gap:56px;
  align-items:center;
}
.eyebrow{
  font-family:var(--mono);
  font-size:13px;
  letter-spacing:0.08em;
  text-transform:uppercase;
  color:var(--signal-dim);
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:22px;
  font-weight:500;
}
.eyebrow::before{
  content:'';
  width:7px;height:7px;
  background:var(--green);
  border-radius:50%;
  animation:pulse 2s ease-in-out infinite;
}
@keyframes pulse{
  0%,100%{opacity:1; box-shadow:0 0 0 0 rgba(37,211,102,0.4);}
  50%{opacity:0.6; box-shadow:0 0 0 6px rgba(37,211,102,0);}
}
h1{
  font-family:var(--display);
  font-weight:800;
  font-size:clamp(38px, 5vw, 60px);
  line-height:1.02;
  letter-spacing:-0.025em;
  margin-bottom:24px;
}
h1 em{
  font-style:normal;
  color:var(--signal);
  position:relative;
}
.hero-sub{
  font-size:18px;
  line-height:1.6;
  color:var(--ink-soft);
  max-width:480px;
  margin-bottom:36px;
}
.hero-ctas{
  display:flex;
  gap:14px;
  align-items:center;
  margin-bottom:38px;
  flex-wrap:wrap;
}
.btn-primary{
  background:var(--signal);
  color:#FFFFFF;
  padding:16px 28px;
  border-radius:8px;
  font-weight:700;
  font-size:16px;
  border:none;
  display:inline-flex;
  align-items:center;
  gap:10px;
  transition:transform 0.15s ease, box-shadow 0.15s ease;
  box-shadow:0 4px 14px rgba(37,211,102,0.35);
}
.btn-primary:hover{background:var(--signal-dim); transform:translateY(-2px); box-shadow:0 8px 20px rgba(37,211,102,0.42);}
.btn-secondary{
  padding:16px 24px;
  font-weight:600;
  font-size:16px;
  color:var(--ink);
  border-bottom:2px solid var(--ink);
  transition:opacity 0.15s;
}
.btn-secondary:hover{opacity:0.65;}
.hero-proof{
  display:flex;
  gap:28px;
  font-size:14px;
  color:var(--gray);
  flex-wrap:wrap;
}
.hero-proof span{
  font-family:var(--mono);
  color:var(--ink);
  font-weight:600;
}

/* ============ PHONE MOCKUP ============ */
.phone-stage{
  display:flex;
  justify-content:center;
  position:relative;
}
.phone{
  width:320px;
  background:var(--ink);
  border-radius:36px;
  padding:12px;
  box-shadow:0 30px 60px -20px rgba(18,21,26,0.4), 0 0 0 1px rgba(18,21,26,0.05);
  position:relative;
}
.phone-screen{
  background:var(--paper-dim);
  border-radius:26px;
  overflow:hidden;
  height:560px;
  display:flex;
  flex-direction:column;
}
.phone-header{
  background:var(--green);
  color:#fff;
  padding:16px 18px 14px;
  display:flex;
  align-items:center;
  gap:10px;
  font-size:14px;
  font-weight:600;
}
.phone-avatar{
  width:32px;height:32px;
  background:rgba(255,255,255,0.25);
  border-radius:50%;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:14px;
  font-weight:700;
}
.phone-header .status{
  font-size:11px;
  font-weight:400;
  opacity:0.85;
  display:block;
  margin-top:1px;
}
.phone-body{
  flex:1;
  padding:16px 12px;
  display:flex;
  flex-direction:column;
  gap:8px;
  overflow:hidden;
  background-image: radial-gradient(circle, rgba(139,131,120,0.08) 1px, transparent 1px);
  background-size:14px 14px;
}
.msg{
  max-width:78%;
  padding:9px 12px;
  border-radius:12px;
  font-size:13.5px;
  line-height:1.4;
  opacity:0;
  animation:msgIn 0.5s ease forwards;
}
.msg.in{
  background:#fff;
  align-self:flex-start;
  border-bottom-left-radius:3px;
}
.msg.out{
  background:var(--green-soft);
  align-self:flex-end;
  border-bottom-right-radius:3px;
  color:#1a3d2c;
}
.msg.out.bot{
  background:var(--ink);
  color:var(--paper);
}
.msg .time{
  display:block;
  font-size:9.5px;
  color:var(--gray);
  margin-top:3px;
  font-family:var(--mono);
}
.msg.out .time{text-align:right; color:rgba(26,61,44,0.5);}
.msg.out.bot .time{color:rgba(247,243,236,0.5);}

@keyframes msgIn{
  from{opacity:0; transform:translateY(8px);}
  to{opacity:1; transform:translateY(0);}
}

.msg1{animation-delay:0.3s;}
.msg2{animation-delay:1.1s;}
.msg3{animation-delay:1.9s;}
.msg4{animation-delay:2.7s;}
.msg5{animation-delay:3.5s;}

.receipt-chip{
  align-self:flex-end;
  background:var(--paper);
  border:1px dashed var(--gray);
  border-radius:8px;
  padding:10px 12px;
  font-family:var(--mono);
  font-size:11px;
  max-width:78%;
  opacity:0;
  animation:msgIn 0.5s ease forwards;
  animation-delay:4.3s;
  color:var(--ink-soft);
}
.receipt-chip .rline{display:flex; justify-content:space-between; margin-bottom:2px;}
.receipt-chip .rtotal{border-top:1px dashed var(--gray); margin-top:5px; padding-top:5px; font-weight:700;}

@media (max-width:960px){
  .hero-grid{grid-template-columns:1fr; text-align:left;}
  .phone-stage{margin-top:10px;}
  .hero{padding:120px 0 60px;}
}
@media (max-width:480px){
  .phone{width:100%; max-width:320px;}
}

/* ============ MARQUEE / TRUST ============ */
.trust-strip{
  border-top:1px solid var(--gray-line);
  border-bottom:1px solid var(--gray-line);
  padding:26px 0;
  overflow:hidden;
}
.trust-inner{
  display:flex;
  align-items:center;
  gap:14px;
  font-family:var(--mono);
  font-size:13px;
  color:var(--gray);
  text-transform:uppercase;
  letter-spacing:0.06em;
  justify-content:center;
  flex-wrap:wrap;
}
.trust-inner b{color:var(--ink); font-weight:600;}
.dot-sep{color:var(--gray-line); font-family:var(--body);}

/* ============ SECTION SHARED ============ */
section{padding:110px 0;}
.section-head{
  max-width:620px;
  margin-bottom:64px;
}
.tag{
  font-family:var(--mono);
  font-size:12.5px;
  text-transform:uppercase;
  letter-spacing:0.08em;
  color:var(--signal-dim);
  font-weight:600;
  margin-bottom:14px;
  display:block;
}
h2{
  font-family:var(--display);
  font-weight:800;
  font-size:clamp(28px, 3.6vw, 42px);
  letter-spacing:-0.02em;
  line-height:1.1;
  margin-bottom:16px;
}
.section-sub{
  font-size:17px;
  color:var(--gray);
  line-height:1.6;
}

/* ============ LEDGER (Before/After) ============ */
.ledger{
  background:var(--ink);
  color:var(--paper);
}
.ledger .tag{color:#25D366;}
.ledger .section-sub{color:rgba(247,243,236,0.6);}
.ledger-table{
  border:1px solid var(--paper-line);
  border-radius:12px;
  overflow:hidden;
}
.ledger-row{
  display:grid;
  grid-template-columns:1fr 1fr;
}
.ledger-row + .ledger-row{border-top:1px solid var(--paper-line);}
.ledger-cell{
  padding:26px 30px;
  font-size:15.5px;
  line-height:1.55;
}
.ledger-cell:first-child{
  border-right:1px solid var(--paper-line);
  color:rgba(247,243,236,0.55);
}
.ledger-cell:last-child{
  color:var(--paper);
  font-weight:500;
  background:rgba(7,94,84,0.06);
}
.ledger-head-row{
  display:grid;
  grid-template-columns:1fr 1fr;
  border-bottom:1px solid var(--paper-line);
}
.ledger-head-cell{
  padding:16px 30px;
  font-family:var(--mono);
  font-size:12px;
  text-transform:uppercase;
  letter-spacing:0.08em;
}
.ledger-head-cell:first-child{
  border-right:1px solid var(--paper-line);
  color:rgba(247,243,236,0.4);
}
.ledger-head-cell:last-child{color:#25D366;}
.strike{text-decoration:line-through; text-decoration-color:rgba(247,243,236,0.3); opacity:0.7;}
.check{color:#25D366; margin-right:8px; font-weight:700;}

@media (max-width:720px){
  .ledger-row, .ledger-head-row{grid-template-columns:1fr;}
  .ledger-cell:first-child, .ledger-head-cell:first-child{border-right:none; border-bottom:1px solid var(--paper-line);}
}

/* ============ FEATURES (receipt line items) ============ */
.features-list{
  border-top:1px solid var(--gray-line);
}
.feature-row{
  display:grid;
  grid-template-columns:70px 1fr 1.3fr;
  gap:32px;
  padding:36px 0;
  border-bottom:1px solid var(--gray-line);
  align-items:start;
}
.feature-num{
  font-family:var(--mono);
  font-size:14px;
  color:var(--gray);
  padding-top:4px;
}
.feature-name{
  font-family:var(--display);
  font-weight:700;
  font-size:21px;
  letter-spacing:-0.01em;
}
.feature-desc{
  font-size:15.5px;
  color:var(--gray);
  line-height:1.65;
  max-width:480px;
}
@media (max-width:720px){
  .feature-row{grid-template-columns:40px 1fr; }
  .feature-desc{grid-column:2; }
}

/* ============ WHO IT'S FOR ============ */
.audience-grid{
  display:grid;
  grid-template-columns:repeat(4, 1fr);
  gap:1px;
  background:var(--gray-line);
  border:1px solid var(--gray-line);
  border-radius:14px;
  overflow:hidden;
}
.audience-card{
  background:var(--paper);
  padding:34px 26px;
  transition:background 0.2s;
}
.audience-card:hover{background:var(--paper-dim);}
.audience-emoji{
  margin-bottom:16px;
  display:block;
  color:var(--ink);
}
.audience-emoji svg{
  width:26px;
  height:26px;
  stroke-width:1.75;
}
.audience-title{
  font-family:var(--display);
  font-weight:700;
  font-size:17px;
  margin-bottom:8px;
}
.audience-desc{
  font-size:14px;
  color:var(--gray);
  line-height:1.5;
}
@media (max-width:860px){
  .audience-grid{grid-template-columns:1fr 1fr;}
}
@media (max-width:520px){
  .audience-grid{grid-template-columns:1fr;}
}

/* ============ PRICING (till receipt) ============ */
.pricing-wrap{
  display:flex;
  justify-content:center;
}
.pricing-grid{
  display:grid;
  grid-template-columns:repeat(3, 1fr);
  gap:22px;
  width:100%;
}
.price-card{
  background:#fff;
  border:1px solid var(--gray-line);
  border-radius:14px;
  padding:34px 28px;
  position:relative;
  display:flex;
  flex-direction:column;
}
.price-card.featured{
  background:var(--ink);
  color:var(--paper);
  border-color:var(--ink);
  transform:scale(1.03);
}
.price-card.featured .price-desc{color:rgba(247,243,236,0.55);}
.price-card.featured .price-tier-line{color:rgba(247,243,236,0.3);}
.featured-badge{
  position:absolute;
  top:-13px; left:28px;
  background:var(--signal);
  color:#fff;
  font-family:var(--mono);
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:0.06em;
  padding:5px 12px;
  border-radius:20px;
  font-weight:600;
}
.price-tier{
  font-family:var(--display);
  font-weight:700;
  font-size:19px;
  margin-bottom:6px;
}
.price-desc{
  font-size:13.5px;
  color:var(--gray);
  margin-bottom:22px;
  min-height:36px;
}
.price-amount{
  font-family:var(--mono);
  font-size:38px;
  font-weight:600;
  margin-bottom:2px;
  letter-spacing:-0.01em;
}
.price-period{
  font-size:13px;
  color:var(--gray);
  margin-bottom:24px;
}
.price-card.featured .price-period{color:rgba(247,243,236,0.5);}
.price-tier-line{
  border-top:1px dashed var(--gray-line);
  margin:0 0 20px;
}
.price-features{
  list-style:none;
  display:flex;
  flex-direction:column;
  gap:11px;
  margin-bottom:28px;
  flex:1;
}
.price-features li{
  font-size:14px;
  display:flex;
  gap:9px;
  line-height:1.4;
}
.price-features li::before{
  content:'✓';
  color:var(--green);
  font-weight:700;
  flex-shrink:0;
}
.price-card.featured .price-features li::before{color:#FAFAF8;}
.price-btn{
  text-align:center;
  padding:13px;
  border-radius:8px;
  font-weight:600;
  font-size:14.5px;
  background:var(--paper-dim);
  color:var(--ink);
  transition:background 0.15s;
}
.price-btn:hover{background:var(--gray-line);}
.price-card.featured .price-btn{
  background:var(--signal);
  color:#fff;
}
.price-card.featured .price-btn:hover{background:var(--signal-dim);}

@media (max-width:860px){
  .pricing-grid{grid-template-columns:1fr; max-width:400px; margin:0 auto;}
  .price-card.featured{transform:none;}
}

/* ============ TESTIMONIAL ============ */
.testimonial-section{
  background:var(--green-soft);
}
.testimonial-wrap{
  max-width:760px;
  margin:0 auto;
  text-align:center;
}
.testimonial-quote{
  font-family:var(--display);
  font-weight:600;
  font-size:clamp(22px, 2.6vw, 30px);
  line-height:1.35;
  letter-spacing:-0.01em;
  color:var(--ink);
  margin-bottom:28px;
}
.testimonial-author{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:12px;
  font-size:14.5px;
}
.testimonial-avatar{
  width:40px;height:40px;
  border-radius:50%;
  background:var(--green);
  color:#fff;
  display:flex;
  align-items:center;
  justify-content:center;
  font-weight:700;
  font-family:var(--display);
}
.testimonial-author-name{font-weight:700;}
.testimonial-author-role{color:var(--gray); font-size:13.5px;}

/* ============ FINAL CTA ============ */
.final-cta{
  background:var(--ink);
  color:var(--paper);
  text-align:center;
  position:relative;
  overflow:hidden;
}
.final-cta::before{
  content:'';
  position:absolute;
  top:-50%; left:50%;
  transform:translateX(-50%);
  width:800px; height:800px;
  background:radial-gradient(circle, rgba(37,211,102,0.15) 0%, transparent 65%);
  pointer-events:none;
}
.final-cta-inner{position:relative; z-index:1;}
.final-cta h2{color:var(--paper); margin-bottom:20px;}
.final-cta p{
  color:rgba(247,243,236,0.6);
  font-size:17px;
  max-width:480px;
  margin:0 auto 40px;
  line-height:1.6;
}
.final-cta .btn-primary{margin:0 auto;}

/* ============ FOOTER ============ */
footer{
  padding:50px 0;
  border-top:1px solid var(--gray-line);
}
.footer-inner{
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:20px;
}
.footer-links{
  display:flex;
  gap:28px;
  font-size:14px;
  color:var(--gray);
}
.footer-links a:hover{color:var(--ink);}
.footer-copy{
  font-size:13px;
  color:var(--gray);
  font-family:var(--mono);
}

/* scroll reveal */
.reveal{
  opacity:0;
  transform:translateY(24px);
  transition:opacity 0.7s ease, transform 0.7s ease;
}
.reveal.is-visible{
  opacity:1;
  transform:translateY(0);
}
/* ============ HERO v2 (DoorDash-style stacked headline) ============ */
.hero-stack h1{
  font-size:clamp(40px, 6.2vw, 68px);
  line-height:0.98;
  margin-bottom:28px;
}
.hero-stack h1 span{display:block;}
.hero-form{
  display:flex;
  gap:10px;
  margin-bottom:14px;
  max-width:460px;
}
.hero-form input{
  flex:1;
  padding:16px 18px;
  border:1px solid var(--gray-line);
  border-radius:8px;
  font-family:inherit;
  font-size:15px;
  background:#fff;
}
.hero-form input:focus{outline:2px solid var(--signal); outline-offset:1px;}
.hero-fine{
  font-size:12.5px;
  color:var(--gray);
  line-height:1.5;
  max-width:440px;
}
.hero-fine a{text-decoration:underline;}

/* ============ WHAT-IS BAND ============ */
.whatis-band{
  background:var(--paper-dim);
  padding:80px 0;
}
.whatis-inner{
  max-width:760px;
  margin:0 auto;
  text-align:center;
}
.whatis-inner h2{margin-bottom:24px;}
.whatis-inner p{
  font-size:16.5px;
  line-height:1.75;
  color:var(--ink-soft);
  margin-bottom:18px;
}
.whatis-inner p:last-child{margin-bottom:0;}

/* ============ WHY LIST (icon-led, centered) ============ */
.why-list{
  max-width:560px;
  margin:0 auto;
  display:flex;
  flex-direction:column;
  gap:56px;
}
.why-item{text-align:center;}
.why-icon{
  width:52px; height:52px;
  margin:0 auto 18px;
  display:flex;
  align-items:center;
  justify-content:center;
  background:var(--green-soft);
  border-radius:14px;
  color:var(--green);
}
.why-icon svg{width:26px; height:26px;}
.why-item h3{
  font-family:var(--display);
  font-weight:700;
  font-size:19px;
  margin-bottom:8px;
}
.why-item p{
  font-size:15px;
  color:var(--gray);
  line-height:1.6;
  max-width:420px;
  margin:0 auto;
}

/* ============ SIGNUP DETAILS BAND (two-column) ============ */
.details-band{
  background:var(--green-soft);
  padding:80px 0;
}
.details-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:48px;
  max-width:760px;
  margin:0 auto;
}
.details-col h3{
  font-family:var(--display);
  font-weight:700;
  font-size:16px;
  text-transform:uppercase;
  letter-spacing:0.04em;
  margin-bottom:18px;
}
.details-col ul{
  list-style:none;
  display:flex;
  flex-direction:column;
  gap:12px;
}
.details-col li{
  font-size:15px;
  line-height:1.5;
  padding-left:20px;
  position:relative;
}
.details-col li::before{
  content:'•';
  position:absolute;
  left:0;
  color:var(--green);
  font-weight:700;
}
@media (max-width:640px){
  .details-grid{grid-template-columns:1fr; gap:32px;}
}

/* ============ FAQ ACCORDION ============ */
.faq-list{
  max-width:720px;
  margin:0 auto;
  display:flex;
  flex-direction:column;
  gap:10px;
}
.faq-item{
  border:1px solid var(--gray-line);
  border-radius:10px;
  overflow:hidden;
  background:#fff;
}
.faq-question{
  width:100%;
  text-align:left;
  padding:20px 22px;
  display:flex;
  justify-content:space-between;
  align-items:center;
  font-family:var(--display);
  font-weight:600;
  font-size:15.5px;
  background:none;
  border:none;
  color:var(--ink);
}
.faq-chevron{
  flex-shrink:0;
  transition:transform 0.25s ease;
  color:var(--gray);
}
.faq-item.open .faq-chevron{transform:rotate(180deg); color:var(--green);}
.faq-answer{
  max-height:0;
  overflow:hidden;
  transition:max-height 0.3s ease;
}
.faq-answer-inner{
  padding:0 22px 20px;
  font-size:14.5px;
  color:var(--gray);
  line-height:1.6;
}
</style>
</head>
<body>

<nav class="nav">
<div class="nav-inner">
<div class="logo"><span class="logo-mark"></span>Relay</div>
<div class="nav-links">
<a href="#how">How it works</a>
<a href="#who">Who it's for</a>
<a href="#why">Why WhatsApp</a>
</div>
<a href="#signup" class="nav-cta">Get Early Access</a>
</div>
</nav>

<header class="hero">
<div class="wrap hero-grid">
<div class="hero-stack">
<div class="eyebrow">Early access now open</div>
<h1><span>Your orders.</span><span>Your WhatsApp.</span><span>Handled.</span></h1>
<p class="hero-sub">Relay turns your customers' WhatsApp messages into confirmed, priced and invoiced orders — for Nigerian wholesalers, restaurants and dropshippers. No app, no forms, no new habit for your buyers.</p>
<form class="hero-form" onsubmit="return false;">
<input type="email" placeholder="Email" required>
<button type="submit" class="btn-primary" style="padding:16px 28px;">Next</button>
</form>
<p class="hero-fine">Free during early access. We'll reach out on WhatsApp — no card needed. <a href="#how">See how it works</a></p>
</div>

<div class="phone-stage">
<div class="phone">
<div class="phone-screen">
<div class="phone-header">
<div class="phone-avatar">AK</div>
<div>
Adeyemi Wholesale
<span class="status">Relay is handling this chat</span>
</div>
</div>
<div class="phone-body">
<div class="msg in msg1">I need 10 bags of rice and 5 cartons of oil for the shop<span class="time">1:14 PM</span></div>
<div class="msg out bot msg2">Got it — 10 bags rice, 5 cartons oil. Checking stock and your credit limit now.<span class="time">1:14 PM</span></div>
<div class="msg out bot msg3">Stock confirmed, credit approved ✅ Total: ₦485,000<span class="time">1:15 PM</span></div>
<div class="msg in msg4">Ok please send invoice<span class="time">1:15 PM</span></div>
<div class="msg out bot msg5">Invoice + payment link sent below 🧾<span class="time">1:16 PM</span></div>
<div class="receipt-chip">
<div class="rline"><span>10x Rice (50kg bag)</span><span>₦350,000</span></div>
<div class="rline"><span>5x Vegetable Oil (carton)</span><span>₦135,000</span></div>
<div class="rline rtotal"><span>TOTAL</span><span>₦485,000</span></div>
</div>
</div>
</div>
</div>
</div>
</div>
</header>

<div class="trust-strip">
<div class="wrap trust-inner">
<span>Built for</span> <b>Wholesalers</b> <span class="dot-sep">·</span> <b>Restaurants</b> <span class="dot-sep">·</span> <b>Dropshippers</b>
</div>
</div>

<div class="whatis-band reveal">
<div class="wrap whatis-inner">
<h2>What is Relay</h2>
<p>Relay is built for the way Nigerian businesses already sell — over WhatsApp. We connect wholesalers, restaurants and dropshippers with an AI ordering assistant that reads customer messages, checks stock and credit, and sends back a confirmed invoice, automatically.</p>
<p>As a business owner, you keep doing exactly what you already do on WhatsApp — Relay just handles the repetitive part. No new app for you or your customers to learn. It's that simple.</p>
</div>
</div>

<section class="ledger" id="how">
<div class="wrap">
<div class="section-head reveal">
<span class="tag">How it works</span>
<h2>Everything happens inside the WhatsApp chat your customers already use.</h2>
</div>

<div class="features-list" style="border-top:1px solid var(--paper-line);">
<div class="feature-row reveal" style="border-bottom:1px solid var(--paper-line);">
<div class="feature-num" style="color:rgba(246,246,240,0.4);">01</div>
<div class="feature-name" style="color:var(--paper);">Customer messages your WhatsApp number</div>
<div class="feature-desc" style="color:rgba(246,246,240,0.55);">They order the way they already do — in plain language, no app to download.</div>
</div>
<div class="feature-row reveal" style="border-bottom:1px solid var(--paper-line);">
<div class="feature-num" style="color:rgba(246,246,240,0.4);">02</div>
<div class="feature-name" style="color:var(--paper);">AI parses the order</div>
<div class="feature-desc" style="color:rgba(246,246,240,0.55);">Products, quantities and delivery details are extracted automatically from the message.</div>
</div>
<div class="feature-row reveal" style="border-bottom:1px solid var(--paper-line);">
<div class="feature-num" style="color:rgba(246,246,240,0.4);">03</div>
<div class="feature-name" style="color:var(--paper);">Supplier and credit checked</div>
<div class="feature-desc" style="color:rgba(246,246,240,0.55);">Stock and credit limits are verified against your catalog and supplier terms.</div>
</div>
<div class="feature-row reveal" style="border-bottom:1px solid var(--paper-line);">
<div class="feature-num" style="color:rgba(246,246,240,0.4);">04</div>
<div class="feature-name" style="color:var(--paper);">Order confirmed and invoiced</div>
<div class="feature-desc" style="color:rgba(246,246,240,0.55);">A confirmation, invoice and secure payment link are sent back — all in WhatsApp.</div>
</div>
</div>
</div>
</section>



<section id="who" style="background:var(--paper-dim);">
<div class="wrap">
<div class="section-head reveal">
<span class="tag">Who it's for</span>
<h2>Built for the way Nigerian B2B ordering actually happens.</h2>
</div>
<div class="audience-grid reveal" style="grid-template-columns:repeat(3, 1fr);">
<div class="audience-card">
<span class="audience-emoji"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73Z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="m7.5 4.27 9 5.15"/></svg></span>
<div class="audience-title">Dropshippers</div>
<div class="audience-desc">Take orders from your customers and pass them to suppliers automatically, without copy-pasting between chats.</div>
</div>
<div class="audience-card">
<span class="audience-emoji"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg></span>
<div class="audience-title">Restaurants</div>
<div class="audience-desc">Receive supply and bulk orders on WhatsApp, with kitchen tickets and confirmations routed to the right team.</div>
</div>
<div class="audience-card">
<span class="audience-emoji"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></svg></span>
<div class="audience-title">B2B & Wholesale suppliers</div>
<div class="audience-desc">Let buyers reorder from your catalog by message, with credit limits and stock checks handled for you.</div>
</div>
</div>
</div>
</section>

<section id="why">
<div class="wrap">
<div class="section-head reveal" style="margin:0 auto 60px; text-align:center;">
<span class="tag" style="display:block; text-align:center;">Why WhatsApp</span>
<h2>Ordering tools fail when they ask customers to change their habits.</h2>
<p class="section-sub" style="margin:0 auto;">WhatsApp removes that friction.</p>
</div>
<div class="why-list reveal">
<div class="why-item">
<div class="why-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg></div>
<h3>No downloads or logins</h3>
<p>Your buyers already have WhatsApp — they do not need another app or password.</p>
</div>
<div class="why-item">
<div class="why-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
<h3>No forms</h3>
<p>Customers order in their own words instead of filling fields on a slow connection.</p>
</div>
<div class="why-item">
<div class="why-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg></div>
<h3>Where the conversation already is</h3>
<p>Quotes, confirmations and payment links stay in the same chat as the order.</p>
</div>
<div class="why-item">
<div class="why-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01"/><path d="m14 15 2 2 4-4"/></svg></div>
<h3>Built for mobile data</h3>
<p>Lightweight text messages work reliably where web apps struggle.</p>
</div>
</div>
</div>
</section>

<div class="details-band reveal">
<div class="wrap">
<div class="section-head reveal" style="margin:0 auto 44px; text-align:center;">
<h2>Early access details</h2>
</div>
<div class="details-grid">
<div class="details-col">
<h3>What you need</h3>
<ul>
<li>An active WhatsApp Business number</li>
<li>A list of what you sell (products or menu)</li>
<li>A way to receive payments (bank or payment link)</li>
</ul>
</div>
<div class="details-col">
<h3>How to sign up</h3>
<ul>
<li>Fill in the early access form below</li>
<li>We reach out on WhatsApp to set up a walkthrough</li>
<li>Connect your WhatsApp Business number</li>
<li>Start taking orders through Relay</li>
</ul>
</div>
</div>
</div>
</div>

<section style="background:var(--paper-dim);">
<div class="wrap" style="max-width:720px;">
<div class="section-head reveal" style="margin-bottom:20px;">
<span class="tag">About Relay</span>
<h2>Built and operated by Moramjab Enterprises.</h2>
</div>
<p class="section-sub reveal" style="margin-bottom:16px;">Moramjab Enterprises is a business based in Nigeria. We build tools to help Nigerian wholesalers, restaurants and dropshippers take and manage orders over WhatsApp, without asking their customers to download a new app or learn a new habit.</p>
<p class="section-sub reveal">Questions about Relay or Moramjab Enterprises? Reach us at <a href="mailto:amramgadzama7@yahoo.com" style="text-decoration:underline;">amramgadzama7@yahoo.com</a>.</p>
</div>
</section>

<section id="signup">
<div class="wrap" style="max-width:560px;">
<div class="section-head reveal" style="margin:0 auto 48px; text-align:center;">
<span class="tag" style="display:block; text-align:center;">Get early access</span>
<h2>Tell us about your business and we'll set you up for a walkthrough.</h2>
</div>

<form class="reveal" style="display:flex; flex-direction:column; gap:16px;" onsubmit="return false;">
<div>
<label style="display:block; font-size:13.5px; font-weight:600; margin-bottom:6px;">Business name</label>
<input type="text" required style="width:100%; padding:14px 16px; border:1px solid var(--gray-line); border-radius:8px; font-family:inherit; font-size:15px; background:#fff;">
</div>
<div>
<label style="display:block; font-size:13.5px; font-weight:600; margin-bottom:6px;">WhatsApp number</label>
<input type="tel" required style="width:100%; padding:14px 16px; border:1px solid var(--gray-line); border-radius:8px; font-family:inherit; font-size:15px; background:#fff;">
</div>
<div>
<label style="display:block; font-size:13.5px; font-weight:600; margin-bottom:6px;">Business type</label>
<select required style="width:100%; padding:14px 16px; border:1px solid var(--gray-line); border-radius:8px; font-family:inherit; font-size:15px; background:#fff;">
<option value="">Select one</option>
<option>Dropshipper</option>
<option>Restaurant</option>
<option>B2B / Wholesale supplier</option>
</select>
</div>
<div>
<label style="display:block; font-size:13.5px; font-weight:600; margin-bottom:6px;">Email</label>
<input type="email" required style="width:100%; padding:14px 16px; border:1px solid var(--gray-line); border-radius:8px; font-family:inherit; font-size:15px; background:#fff;">
</div>
<button type="submit" class="btn-primary" style="justify-content:center; margin-top:8px;">Request Early Access</button>
</form>
</div>
</section>

<section style="background:var(--paper-dim);">
<div class="wrap">
<div class="section-head reveal" style="margin:0 auto 44px; text-align:center;">
<h2>FAQ</h2>
</div>
<div class="faq-list reveal" id="faq-list">
<div class="faq-item">
<button class="faq-question">How does ordering with Relay work?<svg class="faq-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
<div class="faq-answer"><div class="faq-answer-inner">Your customer messages your WhatsApp number as usual. Relay reads the message, checks stock and credit, then sends back a confirmation, invoice and payment link — all inside the same chat.</div></div>
</div>
<div class="faq-item">
<button class="faq-question">Do my customers need to download anything?<svg class="faq-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
<div class="faq-answer"><div class="faq-answer-inner">No. Everything happens inside WhatsApp, which your customers already use. There's no new app, login or form for them to learn.</div></div>
</div>
<div class="faq-item">
<button class="faq-question">Is Relay available now?<svg class="faq-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
<div class="faq-answer"><div class="faq-answer-inner">Relay is currently in early access. Sign up above and we'll reach out on WhatsApp to set up a walkthrough for your business.</div></div>
</div>
<div class="faq-item">
<button class="faq-question">What kind of businesses is Relay built for?<svg class="faq-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
<div class="faq-answer"><div class="faq-answer-inner">Relay is built for Nigerian dropshippers, restaurants, and B2B or wholesale suppliers who already take orders over WhatsApp.</div></div>
</div>
<div class="faq-item">
<button class="faq-question">How does the credit check work?<svg class="faq-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
<div class="faq-answer"><div class="faq-answer-inner">For B2B and wholesale sellers, Relay checks the order against your stock and the buyer's credit terms before it's confirmed, so nothing gets approved that you haven't already allowed.</div></div>
</div>
<div class="faq-item">
<button class="faq-question">How much does Relay cost?<svg class="faq-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
<div class="faq-answer"><div class="faq-answer-inner">Relay is free during early access. We'll share pricing details as we approach general availability.</div></div>
</div>
</div>
</div>
</section>

<section class="final-cta">
<div class="wrap final-cta-inner reveal">
<h2>Ready to stop typing out every order by hand?</h2>
<p>Free during early access. We'll reach out on WhatsApp to get you set up.</p>
<a href="#signup" class="btn-primary">Get Early Access →</a>
</div>
</section>

<footer>
<div class="wrap footer-inner">
<div class="logo"><span class="logo-mark"></span>Relay</div>
<div class="footer-links">
<span class="footer-copy">A product by Moramjab Enterprises</span>
<a href="#">Privacy Policy</a>
<a href="mailto:amramgadzama7@yahoo.com">amramgadzama7@yahoo.com</a>
</div>
</div>
</footer>

<script>
const revealEls = document.querySelectorAll('.reveal');
const io = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if(entry.isIntersecting){
      entry.target.classList.add('is-visible');
      io.unobserve(entry.target);
    }
  });
}, {threshold:0.15});
revealEls.forEach(el => io.observe(el));

// Loop the phone chat animation
function loopChat(){
  const msgs = document.querySelectorAll('.msg, .receipt-chip');
  msgs.forEach(m => {
    m.style.animation = 'none';
    void m.offsetWidth;
    m.style.animation = null;
  });
}
setInterval(loopChat, 7000);

// FAQ accordion
document.querySelectorAll('.faq-item').forEach(item => {
  const btn = item.querySelector('.faq-question');
  const answer = item.querySelector('.faq-answer');
  btn.addEventListener('click', () => {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(other => {
      if(other !== item){
        other.classList.remove('open');
        other.querySelector('.faq-answer').style.maxHeight = null;
      }
    });
    if(isOpen){
      item.classList.remove('open');
      answer.style.maxHeight = null;
    } else {
      item.classList.add('open');
      answer.style.maxHeight = answer.scrollHeight + 'px';
    }
  });
});
</script>

</body>
</html>`;

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Relay — Privacy Policy</title>
<style>
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  background: #0B3D2E; color: #e6efe9; line-height: 1.7; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 20px 72px; }
  h1 { color: #fff; font-size: 30px; margin: 0 0 8px; }
  h2 { color: #fff; font-size: 18px; margin: 28px 0 6px; }
  a { color: #7fe3b4; }
  .brand { color: #fff; font-weight: 800; font-size: 20px; margin-bottom: 24px; }
  .updated { color: #9db3a8; font-size: 13px; margin-bottom: 32px; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border: 1px solid #1d4a3a; }
  th { background: #123f30; }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
  .contact-box { margin-top: 10px; padding: 14px 16px; border: 1px solid #1d4a3a; border-radius: 8px; background: #123f30; }
  </style>
  </head>
  <body>
  <div class="wrap">
  <div class="brand">Relay</div>
  <h1>Privacy Policy</h1>
  <div class="updated">Last updated: September 17, 2026</div>

  <p>Relay ("Relay", "we", "us", or "our") is a WhatsApp-based ordering platform built and operated by <strong>Moramjab Enterprises</strong>, a business based in Nigeria. Relay lets businesses receive, process, and confirm customer and supplier orders through WhatsApp messaging. This policy explains what information we collect, how we use it, and the choices available to you.</p>

  <h2>1. Who this policy covers</h2>
  <ul>
  <li><strong>Business clients</strong> — companies that use Relay to run their order-taking on WhatsApp.</li>
  <li><strong>Customers</strong> — people who message a Relay-powered WhatsApp number to place an order with one of our business clients.</li>
  <li><strong>Suppliers</strong> — people or businesses who receive and confirm orders through Relay on behalf of a business client.</li>
  <li><strong>Prospective clients</strong> — people who submit the early-access form on this site.</li>
  </ul>

  <h2>2. Information we collect</h2>
  <table>
  <tr><th>Category</th><th>Examples</th></tr>
  <tr><td>Early-access signups</td><td>Business name, WhatsApp number, business category, and email address submitted through our website form.</td></tr>
  <tr><td>WhatsApp messaging data</td><td>Phone number, message content, message timestamps, and delivery/read status, received via the WhatsApp Business Platform (Meta).</td></tr>
  <tr><td>Order information</td><td>Products ordered, quantities, prices, delivery location, payment status, and order history.</td></tr>
  <tr><td>Business account information</td><td>Business name, business category, operations and kitchen contact numbers, and settlement/payout details provided by our business clients.</td></tr>
  <tr><td>Payment information</td><td>Payment status and transaction references from our payment processor (Monnify). We do not store full card or bank credentials ourselves.</td></tr>
  <tr><td>Conversation state</td><td>The current stage of an in-progress order (e.g. awaiting confirmation), stored temporarily to allow multi-step conversations.</td></tr>
  </table>

  <h2>3. How we use this information</h2>
  <ul>
  <li>To respond to early-access requests and set up onboarding walkthroughs.</li>
  <li>To receive, parse, and process orders sent via WhatsApp, including using automated natural-language parsing to interpret order messages.</li>
  <li>To match orders to the correct business, product, and supplier.</li>
  <li>To send order confirmations, invoices, and payment links back to the relevant customer or supplier over WhatsApp.</li>
  <li>To notify business operations contacts of new or pending orders.</li>
  <li>To maintain order history and basic reporting for our business clients.</li>
  <li>To troubleshoot, secure, and improve the reliability of the platform.</li>
  </ul>
  <p>We do not sell personal information, and we do not use customer or supplier messaging data for advertising.</p>

  <h2>4. How information is processed and stored</h2>
  <ul>
  <li>Messages are received and sent through the WhatsApp Business Platform, operated by Meta, subject to Meta's own terms and policies.</li>
  <li>Order content is parsed using an AI language model to extract structured order details (such as product name and quantity) from natural-language messages.</li>
  <li>Order, client, supplier, and product data is stored in a hosted database with access restricted to Relay's operating infrastructure.</li>
  <li>Payment status is processed through our payment partner, Monnify, which handles payment collection directly.</li>
  </ul>

  <h2>5. Data sharing</h2>
  <ul>
  <li>With the specific business client an order belongs to (a business only sees its own orders and customers, not other businesses' data).</li>
  <li>With Meta, as the operator of the WhatsApp Business Platform used to send and receive messages.</li>
  <li>With our payment processing partner, to facilitate order payment.</li>
  <li>Where required by law, or to protect the rights, safety, or property of Relay, our clients, or the public.</li>
  </ul>

  <h2>6. Data retention</h2>
  <p>We retain order and messaging data for as long as reasonably necessary to provide the service, maintain accurate business records, and meet legal or accounting obligations. Business clients may request deletion of their account data, subject to any records we are required to keep by law.</p>

  <h2>7. Your choices</h2>
  <ul>
  <li>Customers and suppliers can stop messaging a Relay-powered WhatsApp number at any time to end an interaction.</li>
  <li>You may request access to, correction of, or deletion of your personal information by contacting us using the details below.</li>
  <li>Business clients can request an export or deletion of their business's stored data.</li>
  </ul>

  <h2>8. Children's privacy</h2>
  <p>Relay is intended for business use and is not directed at children. We do not knowingly collect personal information from children.</p>

  <h2>9. Changes to this policy</h2>
  <p>We may update this policy from time to time. Material changes will be reflected by updating the "Last updated" date above.</p>

  <h2>10. Contact</h2>
  <div class="contact-box">
  <p style="margin:0">Questions or data requests? Email <a href="mailto:amramgadzama7@yahoo.com">amramgadzama7@yahoo.com</a>.</p>
  </div>

  <p style="margin-top:32px"><a href="/">&larr; Back to Relay</a></p>
  </div>
  </body>
  </html>`;
  router.get('/', (req, res) => {
    res.status(200).type('html').send(LANDING_HTML);
  });

  router.get('/privacy-policy', (req, res) => {
    res.status(200).type('html').send(PRIVACY_HTML);
  });

  module.exports = router;
  module.exports.LANDING_HTML = LANDING_HTML;
