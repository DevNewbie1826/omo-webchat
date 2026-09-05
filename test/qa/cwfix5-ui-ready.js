// Installed before navigation; observes fixture hydration, never polls.
window.qaReady = new Promise((resolve, reject) => {
 const timer = setTimeout(() => { observer.disconnect(); reject(new Error('fixture render deadline')); }, 15000);
 const observer = new MutationObserver(check);
 function check() { if (document.querySelector('.th-goal-bar') && document.querySelector('.th-activity-shelf') && document.querySelector('.th-model-picker-btn') && document.querySelector('.th-chat-msg')) { clearTimeout(timer); observer.disconnect(); resolve(true); } }
 observer.observe(document, {childList:true,subtree:true}); check();
});
