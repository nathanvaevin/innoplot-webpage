// InnoPlot Library: email-gated PDF downloads and placeholder buy buttons.
const modal=document.getElementById('modal'),dialog=document.getElementById('dialog'),
      form=document.getElementById('form'),toast=document.getElementById('toast');
let current='',currentFile='';

function openModal(name,file){
  current=name;currentFile=file||'';
  document.getElementById('docname').textContent='“'+name+'”';
  dialog.classList.remove('sent');form.reset();
  modal.classList.add('open');
  setTimeout(()=>document.getElementById('email').focus(),50);
}
function closeModal(){modal.classList.remove('open')}

document.querySelectorAll('[data-doc]').forEach(b=>b.addEventListener('click',()=>openModal(b.dataset.doc,b.dataset.file)));
document.getElementById('close').addEventListener('click',closeModal);
modal.addEventListener('click',e=>{if(e.target===modal)closeModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});

// Store the lead in Supabase (see supabase/schema.sql). Fire-and-forget: the
// download must never depend on this call succeeding.
function captureLead(email,resource){
  const cfg=window.INNOPLOT_CONFIG||{};
  if(!cfg.supabaseUrl||!cfg.supabaseAnonKey)return;
  fetch(cfg.supabaseUrl+'/rest/v1/rpc/capture_lead',{
    method:'POST',keepalive:true,
    headers:{'Content-Type':'application/json',apikey:cfg.supabaseAnonKey,Authorization:'Bearer '+cfg.supabaseAnonKey},
    body:JSON.stringify({p_email:email,p_resource:resource,p_source_page:location.pathname,p_consent:true})
  }).catch(()=>{});
}

form.addEventListener('submit',e=>{
  e.preventDefault();
  const email=document.getElementById('email').value;
  captureLead(email,current);
  document.getElementById('sentto').textContent=email;
  dialog.classList.add('sent');
  if(currentFile){
    const a=document.createElement('a');
    a.href=currentFile;a.download='';
    document.body.appendChild(a);a.click();a.remove();
  }
});

function showToast(msg,ms){
  toast.textContent=msg;toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'),ms||2600);
}

// Buy buttons open the Stripe Payment Link in data-href; without one they say "coming soon".
document.querySelectorAll('[data-buy]').forEach(b=>b.addEventListener('click',()=>{
  if(b.dataset.href){location.href=b.dataset.href;return}
  showToast('Purchase link for “'+b.dataset.buy+'” coming soon');
}));

// Stripe redirects back to ?order=success after a completed payment.
if(new URLSearchParams(location.search).get('order')==='success'){
  showToast('Thank you for your order! You’ll receive a confirmation email shortly.',6000);
  history.replaceState(null,'',location.pathname);
}

// Resource filters (resources page only)
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{
  document.querySelectorAll('.chip').forEach(x=>x.setAttribute('aria-pressed',x===c));
  const f=c.dataset.filter;
  document.querySelectorAll('[data-type]').forEach(a=>a.hidden=!(f==='all'||a.dataset.type===f));
}));
