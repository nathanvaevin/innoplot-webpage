// InnoPlot Library: email-gated PDF downloads and placeholder buy buttons.
const modal=document.getElementById('modal'),dialog=document.getElementById('dialog'),
      form=document.getElementById('form'),toast=document.getElementById('toast');
let current='';

function openModal(name){
  current=name;
  document.getElementById('docname').textContent='“'+name+'”';
  dialog.classList.remove('sent');form.reset();
  modal.classList.add('open');
  setTimeout(()=>document.getElementById('email').focus(),50);
}
function closeModal(){modal.classList.remove('open')}

document.querySelectorAll('[data-doc]').forEach(b=>b.addEventListener('click',()=>openModal(b.dataset.doc)));
document.getElementById('close').addEventListener('click',closeModal);
modal.addEventListener('click',e=>{if(e.target===modal)closeModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});

form.addEventListener('submit',e=>{
  e.preventDefault();
  const email=document.getElementById('email').value;
  // TODO: send {email, document: current} to your backend / email service here.
  document.getElementById('sentto').textContent=email;
  dialog.classList.add('sent');
});

// Buy buttons: no link yet. Set data-href on a button later to enable.
document.querySelectorAll('[data-buy]').forEach(b=>b.addEventListener('click',()=>{
  if(b.dataset.href){window.open(b.dataset.href,'_blank','noopener');return}
  toast.textContent='Purchase link for “'+b.dataset.buy+'” coming soon';
  toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2600);
}));

// Resource filters (resources page only)
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{
  document.querySelectorAll('.chip').forEach(x=>x.setAttribute('aria-pressed',x===c));
  const f=c.dataset.filter;
  document.querySelectorAll('[data-type]').forEach(a=>a.hidden=!(f==='all'||a.dataset.type===f));
}));
