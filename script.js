(() => {
  'use strict';
  const config = window.BARBAROSSA_CONFIG;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => `${new Intl.NumberFormat('ru-RU').format(value)} р.`;
  const norm = value => value.toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
  const MAX_QUANTITY = 99;
  const panel = $('#panel');
  const content = $('#panel-content');
  const state = { menu: [], cart: {}, comment: '', category: 'Всё', maxPrice: Infinity, query: '', panel: null, expanded: null, dish: null, variant: null, storageWarning: false };
  let categories = [];
  let maxPrice = 1050;
  let lastFocus = null;
  let scrollY = 0;
  let toastTimer;
  let panelFrame = 0;
  let panelFocusTimer = 0;
  let panelMotionRevision = 0;
  if ('ResizeObserver' in window) {
    new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty('--bar-height',`${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
    }).observe($('#menu-bar'));
  }
  const icons = {
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg>',
    store: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v11h16V10M2 9l2-6h16l2 6c0 3-5 3-5 0 0 3-5 3-5 0 0 3-5 3-5 0 0 3-5 3-5 0ZM9 21v-7h6v7"/></svg>'
  };
  const dishById = id => state.menu.find(d => d.id === id);
  const variantOf = (dish, id) => dish?.variants?.find(v => v.id === id);
  const priceOf = (dish, variant) => dish?.variants ? variantOf(dish, variant)?.price : dish?.price;
  const minimum = dish => dish.variants ? Math.min(...dish.variants.map(v => v.price)) : typeof dish.price === 'number' ? dish.price : Infinity;
  function displayPrice(dish) {
    if (dish.variants) {
      const prices = [...new Set(dish.variants.map(v => v.price))];
      return `${prices.length > 1 ? 'от ' : ''}${money(Math.min(...prices))}`;
    }
    return typeof dish.price === 'number' ? money(dish.price) : dish.price;
  }
  const keyFor = (id, variant) => `${id}::${variant || ''}`;
  const entries = () => Object.entries(state.cart).map(([key,item]) => {
    const dish = dishById(item.id);
    const variant = variantOf(dish,item.variant);
    const price = priceOf(dish,item.variant);
    return { key, ...item, dish, variantInfo: variant, price, sum: price * item.qty };
  });
  const total = () => entries().reduce((sum,item) => sum + item.sum,0);
  const selectedCount = () => state.cart[keyFor(state.dish,state.variant)]?.qty || 0;
  function toast(message) {
    // A live region inside the modal remains accessible while the rest of the page is inert.
    const modalStatus = $('#panel-status');
    if (panel.open && modalStatus) { modalStatus.textContent = message; modalStatus.hidden = false; }
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'),4000);
  }
  function saveCart() {
    try { localStorage.setItem(config.STORAGE_KEY,JSON.stringify({version:1,items:state.cart,comment:state.comment})); }
    catch { if (!state.storageWarning) { state.storageWarning=true; toast('Браузер не разрешил сохранение. Заказ доступен до закрытия страницы.'); } }
  }
  function restoreCart(raw) {
    state.cart={}; state.comment='';
    try {
      const data=JSON.parse(raw);
      if (!data || data.version !== 1 || !data.items || typeof data.items !== 'object' || Array.isArray(data.items)) return;
      for (const item of Object.values(data.items)) {
        if (!item || typeof item !== 'object') continue;
        const dish=dishById(item.id);
        if (!dish || (dish.variants ? !variantOf(dish,item.variant) : !!item.variant)) continue;
        const price=priceOf(dish,item.variant);
        if (typeof price !== 'number' || !Number.isFinite(price) || !Number.isInteger(item.qty) || item.qty<1 || item.qty>MAX_QUANTITY) continue;
        state.cart[keyFor(item.id,item.variant)]={id:item.id,variant:item.variant || null,qty:item.qty};
      }
      if (typeof data.comment==='string') state.comment=data.comment.slice(0,1000);
    } catch { /* Corrupt or unavailable storage must not break the menu. */ }
  }
  function changeItem(id,variant,delta) {
    const dish=dishById(id);
    if (!dish || typeof priceOf(dish,variant)!=='number') { toast('Цена пока не указана. Эту позицию нельзя добавить в заказ.'); return; }
    const key=keyFor(id,variant);
    const qty=(state.cart[key]?.qty || 0)+delta;
    if (qty>MAX_QUANTITY) { toast(`Максимум ${MAX_QUANTITY} порций одной позиции.`); return; }
    if (qty<=0) delete state.cart[key];
    else state.cart[key]={id,variant:variant || null,qty};
    saveCart(); syncOrderSummary();
    if (state.panel==='dish') syncDetail();
    else if (state.panel==='cart' || state.panel==='menu') renderPanel(true);
  }
  function clearCart() {
    state.cart={}; state.comment=''; saveCart(); syncOrderSummary();
    if (state.panel) renderPanel(true);
  }
  function syncOrderSummary() {
    const hasItems=Object.keys(state.cart).length>0;
    $('.order-dot').hidden=!hasItems;
    $('.order-total').hidden=!hasItems;
    $('.order-total').textContent=money(total());
    const quantity=Object.values(state.cart).reduce((sum,item)=>sum+item.qty,0);
    $('.floating-order').setAttribute('aria-label',hasItems?`Ваш заказ: ${quantity} шт., ${money(total())}`:'Ваш заказ, пока пусто');
  }
  function photo(dish,className='',lazy=true) {
    return `<img class="${className}" src="${esc(dish.image)}" alt="${esc(dish.name)}" ${lazy?'loading="lazy"':''} decoding="async" width="640" height="640" data-photo="${esc(dish.id)}">`;
  }
  function wirePhotoErrors(root=document) {
    $$('img[data-photo]',root).forEach(img=>{
      const fallback=()=>{
        if (!img.isConnected) return;
        const placeholder=document.createElement('div');
        placeholder.className=`photo-placeholder ${img.classList.contains('detail-image')?'detail-image':''} ${img.closest('.cart-item')?'cart-thumb-placeholder':''}`;
        placeholder.setAttribute('role','img');
        placeholder.setAttribute('aria-label',`${img.alt} — фото готовится`);
        placeholder.innerHTML=`<span>${esc(img.alt)}</span><small>ФОТО ГОТОВИТСЯ</small>`;
        img.replaceWith(placeholder);
      };
      img.addEventListener('error',fallback,{once:true});
      if (img.complete && !img.naturalWidth) fallback();
    });
  }
  function renderCategories() {
    $('#categories').innerHTML=['Всё',...categories].map(category=>`<button class="category ${state.category===category?'active':''}" data-action="category" data-category="${esc(category)}" aria-pressed="${state.category===category}">${esc(category)}</button>`).join('');
  }
  function renderMenu() {
    renderCategories();
    const visible=state.menu.filter(dish=>(state.category==='Всё'||dish.category===state.category)&&(!state.query||norm(dish.name).includes(norm(state.query)))&&(state.maxPrice===maxPrice||minimum(dish)<=state.maxPrice));
    $('#section-title').innerHTML=`${esc(state.category==='Всё'?'Всё меню':state.category)}<span class="heading-dot">.</span>`;
    $('#result-count').textContent=`${visible.length} ${new Intl.PluralRules('ru').select(visible.length)==='one'?'позиция':new Intl.PluralRules('ru').select(visible.length)==='few'?'позиции':'позиций'}`;
    $('#dish-grid').innerHTML=visible.map((dish,index)=>{
      return `<article class="dish" id="dish-${esc(dish.id)}" data-dish="${esc(dish.id)}"><div class="dish-media"><button class="photo-button" data-action="dish" data-id="${esc(dish.id)}" aria-label="Открыть: ${esc(dish.name)}" aria-haspopup="dialog">${photo(dish,'',index>5)}</button>${dish.demo?'<span class="demo-badge">[ДЕМО]</span>':''}</div><div class="dish-bottom"><button class="name-pill" data-action="dish" data-id="${esc(dish.id)}" title="${esc(dish.name)}" aria-haspopup="dialog">${esc(dish.name)}</button><span class="price-pill">${esc(displayPrice(dish))}</span></div></article>`;
    }).join('');
    $('#dish-grid').setAttribute('aria-busy','false');
    $('#empty-state').hidden=visible.length>0;
    $('.filter-dot').hidden=state.category==='Всё'&&state.maxPrice===maxPrice;
    wirePhotoErrors($('#dish-grid'));
  }
  function setCategory(category,scroll=false) {
    if (category!=='Всё'&&!categories.includes(category)) return;
    state.category=category; renderMenu();
    if (scroll) $('#menu').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  }
  function resetFilters() {
    state.category='Всё'; state.maxPrice=maxPrice; state.query=''; $('#search').value=''; renderMenu();
    if (state.panel==='filters') renderPanel(true);
  }
  function top(title,compact=false) { return `<div class="panel-top${compact?' compact':''}"><h2 id="panel-title"${compact?' class="sr-only"':''}>${esc(title)}</h2><button class="close-button" data-action="close" aria-label="Закрыть">×</button></div>`; }
  function cancelPanelEntrance() {
    panelMotionRevision++;
    cancelAnimationFrame(panelFrame);
    clearTimeout(panelFocusTimer);
  }
  function revealPanel() {
    const revision=panelMotionRevision;
    const current=()=>panel.open&&revision===panelMotionRevision;
    const finish=()=>{
      if(!current()) return;
      content.removeAttribute('inert');
      $('.close-button',panel)?.focus({preventScroll:true});
    };
    if(matchMedia('(prefers-reduced-motion: reduce)').matches) {
      panel.classList.add('is-ready','is-visible'); finish(); return;
    }
    // The first frame establishes the surface at its own edge. Only the next
    // frame starts the transition, so Safari cannot paint the opposite edge.
    panelFrame=requestAnimationFrame(()=>{
      if(!current()) return;
      panel.classList.add('is-ready');
      panelFrame=requestAnimationFrame(()=>{
        if(!current()) return;
        panel.classList.add('is-visible');
        panelFocusTimer=setTimeout(finish,260);
      });
    });
  }
  function showPanel(kind) {
    const first=!panel.open;
    if (first) { lastFocus=document.activeElement; scrollY=window.scrollY; document.body.style.position='fixed'; document.body.style.top=`-${scrollY}px`; document.body.style.width='100%'; }
    cancelPanelEntrance();
    // showModal() autofocus must not scroll to a close button while that button
    // is translated outside the viewport. The dialog itself receives focus.
    content.setAttribute('inert','');
    state.panel=kind;
    const placement=['dish','cart','checkout'].includes(kind)?'sheet':kind==='menu'?'side side-right':'side side-left';
    panel.className=`panel ${placement} ${kind}-panel`;
    renderPanel();
    if (first) panel.showModal();
    panel.scrollTop=0; panel.scrollLeft=0;
    revealPanel();
  }
  function closePanel() { if (panel.open) panel.close(); }
  panel.addEventListener('close',()=>{
    cancelPanelEntrance();
    panel.classList.remove('is-ready','is-visible');
    content.removeAttribute('inert');
    state.panel=null;
    document.body.style.position=''; document.body.style.top=''; document.body.style.width='';
    window.scrollTo({top:scrollY,behavior:'instant'});
    if (lastFocus?.isConnected) lastFocus.focus({preventScroll:true});
  });
  let backdropStart=false;
  panel.addEventListener('pointerdown',e=>{backdropStart=e.target===panel;});
  panel.addEventListener('click',e=>{if(e.target===panel&&backdropStart) closePanel();});
  function openDish(id) {
    if (!dishById(id)) return;
    state.dish=id; state.variant=null;
    showPanel('dish');
  }
  function quantity(id,variant,count,disabled=false) {
    return `<div class="quantity"><button data-action="line-minus" data-id="${esc(id)}" data-variant="${esc(variant||'')}" aria-label="Уменьшить количество" ${!count||disabled?'disabled':''}>−</button><output aria-live="polite">${count}</output><button data-action="line-plus" data-id="${esc(id)}" data-variant="${esc(variant||'')}" aria-label="Увеличить количество" ${disabled?'disabled':''}>+</button></div>`;
  }
  function detailContent() {
    const dish=dishById(state.dish);
    const price=priceOf(dish,state.variant);
    const disabled=typeof price!=='number';
    return `${top(dish.name,true)}<div class="panel-scroll detail-content">${photo(dish,'detail-image',false)}${dish.variants?`<fieldset class="variants"><legend>Выберите вариант</legend><div class="variant-options">${dish.variants.map(v=>`<button class="variant-button" data-action="variant" data-variant="${esc(v.id)}" aria-pressed="${state.variant===v.id}">${esc(v.name)}<span>${money(v.price)}</span></button>`).join('')}</div></fieldset>`:''}<div class="detail-bottom">${quantity(dish.id,state.variant,selectedCount(),disabled)}<h3 class="detail-name">${esc(dish.name)}</h3><div class="detail-price">${typeof price==='number'?money(price):esc(displayPrice(dish))}${dish.variants&&!state.variant?'<small>Сначала выберите вариант</small>':''}</div></div>${dish.demo?'<p class="notice">[ДЕМО] Цена не указана. Добавление в заказ недоступно.</p>':''}<p id="panel-status" class="notice" role="status" hidden></p></div>`;
  }
  function syncDetail() {
    const q=$('.detail-bottom .quantity');
    if (!q) return;
    $('output',q).textContent=selectedCount();
    $('[data-action="line-minus"]',q).disabled=!selectedCount();
  }
  function menuContent() {
    return `${top('Меню',true)}<div class="panel-scroll"><div class="accordion-section"><button class="accordion-trigger ${state.category==='Всё'?'selected':''}" data-action="menu-category" data-category="Всё"><span class="current-dot"></span>Всё меню</button></div>${categories.map(category=>{
      const expanded=state.expanded===category;
      return `<section class="accordion-section"><button class="accordion-trigger ${state.category===category?'selected':''}" data-action="menu-category" data-category="${esc(category)}" aria-expanded="${expanded}"><span class="current-dot"></span>${esc(category)}<span class="chevron">${expanded?'−':'+'}</span></button>${expanded?`<div class="accordion-body">${state.menu.filter(d=>d.category===category).map(d=>`<button class="menu-dish-link" data-action="menu-dish" data-id="${d.id}"><span>${esc(d.name)}${d.demo?' [ДЕМО]':''}</span><span class="menu-price">${esc(displayPrice(d))}</span></button>`).join('')}</div>`:''}</section>`;
    }).join('')}</div><div class="drawer-order"><div class="drawer-order-lines">${entries().map(item=>`<div class="drawer-order-line">${esc(item.dish.name)}${item.variantInfo?`, ${esc(item.variantInfo.name)}`:''}<small>${item.qty} × ${money(item.price)} = ${money(item.sum)}</small></div>`).join('')}</div><div class="drawer-total"><button class="clear-circle" data-action="clear-cart" aria-label="Очистить корзину" ${entries().length?'':'disabled'}>${icons.trash}</button><button data-action="cart">ИТОГО: ${money(total())}</button></div></div>`;
  }
  function filterContent() {
    return `${top('Фильтры')}<div class="panel-scroll filter-content"><label class="field">Категория<select id="filter-category">${['Всё',...categories].map(c=>`<option ${state.category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label><label class="field"><span class="field-title"><span>Цена до</span><output id="range-price">${money(state.maxPrice)}</output></span><input id="price-range" type="range" min="0" max="${maxPrice}" step="10" value="${state.maxPrice}" aria-label="Цена до" aria-valuetext="${money(state.maxPrice)}"><span class="range-ends"><span>0 р.</span><span>${money(maxPrice)}</span></span></label><div class="filter-actions"><button class="primary-button" data-action="close">Показать блюда</button><button class="reset-circle" data-action="reset-filters" aria-label="Сбросить фильтры">↺</button></div><button class="about-link" data-action="about">${icons.store}О кафе</button></div>`;
  }
  function cartContent() {
    const items=entries();
    return `${top('Ваш заказ')}<div class="panel-scroll cart-lines">${items.length?items.map(item=>`<article class="cart-item">${photo(item.dish,'',false)}<div class="cart-item-info"><h3>${esc(item.dish.name)}</h3>${item.variantInfo?`<small>${esc(item.variantInfo.name)}</small>`:''}<small>${item.qty} × ${money(item.price)} = ${money(item.sum)}</small><div class="cart-item-bottom">${quantity(item.id,item.variant,item.qty)}<b>${money(item.sum)}</b></div></div></article>`).join(''):'<p class="empty-cart">Корзина пуста</p>'}<p id="panel-status" class="notice" role="status" hidden></p></div><div class="cart-footer"><div class="cart-total"><span>Итого:</span><b>${money(total())}</b></div><label class="field cart-comment">Комментарий к заказу<textarea id="order-comment" maxlength="1000" placeholder="Например: без лука, упакуйте с собой…">${esc(state.comment)}</textarea></label><div class="cart-actions"><button class="primary-button order-submit" data-action="checkout" ${items.length?'':'disabled'}>Заказать</button><button class="clear-circle" data-action="clear-cart" aria-label="Очистить корзину" ${items.length||state.comment?'':'disabled'}>${icons.trash}</button></div></div>`;
  }
  function socialLink(service,label) {
    return `<a href="${esc(socialURL(service)||'#')}" class="primary-button ${service==='whatsapp'?'gold':''}" data-social="${service}" ${socialURL(service)?'target="_blank" rel="noopener noreferrer"':''}>${label}</a>`;
  }
  function aboutContent() {
    const phone=String(config.PHONE).replace(/[\s()-]/g,'');
    const contact=/^\+?\d{7,15}$/.test(phone)?`<a href="tel:${phone}">${esc(config.PHONE)}</a>`:esc(config.PHONE);
    return `${top('О кафе')}<div class="panel-scroll"><img class="about-logo" src="assets/logo.svg" alt="BARBAROSSA"><p class="about-copy">${esc(config.DESCRIPTION)}</p><dl class="about-details"><div><dt>Адрес</dt><dd>${esc(config.ADDRESS)}</dd></div><div><dt>Телефон</dt><dd>${contact}</dd></div><div><dt>Часы работы</dt><dd>${esc(config.HOURS)}</dd></div></dl><div class="about-social">${socialLink('whatsapp','WhatsApp')}${socialLink('instagram','Instagram')}</div><p id="panel-status" class="notice" role="status" hidden></p></div>`;
  }
  function checkoutContent() {
    return `${top('Самовывоз')}<div class="panel-scroll"><p class="notice">Демонстрационная форма. Заказ не отправляется в кафе. Оплата будет подключена позже.</p><form id="checkout-form" class="checkout-form"><label class="field">Имя<input name="name" autocomplete="given-name" maxlength="80" required placeholder="Как к вам обращаться"></label><label class="field">Телефон<input name="phone" type="tel" autocomplete="tel" inputmode="tel" pattern="[+0-9\\s\\(\\)\\-]{7,24}" maxlength="24" required placeholder="+7 …"></label><label class="field">Время самовывоза<input name="pickup" type="time" required></label><div class="cart-total"><span>Итого</span><b>${money(total())}</b></div><button class="primary-button gold" type="submit">Проверить данные</button><button class="text-button" type="button" data-action="cart">Вернуться к заказу</button></form></div>`;
  }
  function renderPanel(preserveFocus=false) {
    const focused=document.activeElement;
    const focusAction=focused?.dataset?.action;
    const focusId=focused?.dataset?.id;
    const focusVariant=focused?.dataset?.variant;
    const focusCategory=focused?.dataset?.category;
    const previousScroll=$('.panel-scroll',content)?.scrollTop || 0;
    const render={dish:detailContent,menu:menuContent,filters:filterContent,cart:cartContent,about:aboutContent,checkout:checkoutContent}[state.panel];
    if (!render) return;
    content.innerHTML=render();
    wirePhotoErrors(content);
    if (preserveFocus) {
      const target=$$('[data-action]',content).find(el=>el.dataset.action===focusAction&&el.dataset.id===focusId&&el.dataset.variant===focusVariant&&el.dataset.category===focusCategory);
      (target&&!target.disabled?target:$('.close-button',content))?.focus({preventScroll:true});
      const scroll=$('.panel-scroll',content); if(scroll) scroll.scrollTop=previousScroll;
    }
  }
  function whatsappNumber() { const value=String(config.WHATSAPP).replace(/[\s()+-]/g,''); return /^\d{7,15}$/.test(value)?value:null; }
  function socialURL(service) {
    if(service==='whatsapp') return whatsappNumber()?`https://wa.me/${whatsappNumber()}`:null;
    try { const url=new URL(config.INSTAGRAM); return url.protocol==='https:'&&(url.hostname==='instagram.com'||url.hostname==='www.instagram.com')?url.href:null; } catch { return null; }
  }
  function orderText() {
    return `Новый заказ:\n${entries().map(item=>`- ${item.dish.name}${item.variantInfo?` (${item.variantInfo.name})`:''} × ${item.qty} = ${money(item.sum)}`).join('\n')}\nИТОГО: ${money(total())}\nКомментарий: ${state.comment.trim()||'—'}`;
  }
  function checkout() {
    if (!entries().length) return;
    if (config.CHECKOUT_MODE==='whatsapp') {
      const number=whatsappNumber();
      if(!number) { toast('Номер WhatsApp кафе пока не указан. Заказ сохранён на этом устройстве.'); return; }
      window.open(`https://wa.me/${number}?text=${encodeURIComponent(orderText())}`,'_blank','noopener,noreferrer');
    } else if(config.CHECKOUT_MODE==='online-stub') showPanel('checkout');
    else toast('Способ заказа пока не настроен. Заказ сохранён.');
  }
  document.addEventListener('click',event=>{
    const social=event.target.closest('[data-social]');
    if(social) {
      const url=socialURL(social.dataset.social);
      if(!url) { event.preventDefault(); toast(`${social.dataset.social==='whatsapp'?'Номер WhatsApp':'Ссылка Instagram'} пока не указан${social.dataset.social==='whatsapp'?'':'а'}.`); }
      else { social.href=url; social.target='_blank'; social.rel='noopener noreferrer'; }
      return;
    }
    const button=event.target.closest('[data-action]');
    if(!button || button.disabled) return;
    const { action,id,variant,category }=button.dataset;
    if(action==='category') setCategory(category,true);
    else if(action==='menu') showPanel('menu');
    else if(action==='filters') showPanel('filters');
    else if(action==='about') showPanel('about');
    else if(action==='cart') showPanel('cart');
    else if(action==='close') closePanel();
    else if(action==='dish') openDish(id);
    else if(action==='line-plus'||action==='line-minus') changeItem(id,variant||null,action==='line-plus'?1:-1);
    else if(action==='variant') { state.variant=variant; renderPanel(true); }
    else if(action==='clear-cart') clearCart();
    else if(action==='reset-filters') resetFilters();
    else if(action==='checkout') checkout();
    else if(action==='search') {
      $('#search-box').hidden=!$('#search-box').hidden;
      button.setAttribute('aria-expanded',String(!$('#search-box').hidden));
      if(!$('#search-box').hidden) $('#search').focus();
    }
    else if(action==='clear-search') { state.query=''; $('#search').value=''; renderMenu(); $('#search').focus(); }
    else if(action==='menu-category') { state.expanded=state.expanded===category?null:category; setCategory(category); renderPanel(true); }
    else if(action==='menu-dish') {
      const dish=dishById(id);
      // Close must finish unlocking the page before scrolling to the requested dish.
      panel.addEventListener('close',()=>{
        state.query=''; $('#search').value=''; state.maxPrice=maxPrice; setCategory(dish.category);
        $(`#dish-${id}`).scrollIntoView({behavior:'instant',block:'center'});
        lastFocus=$(`#dish-${id} .name-pill`);
        lastFocus.focus({preventScroll:true});
        openDish(id);
      },{once:true});
      closePanel();
    }
    else if(action==='reload') location.reload();
  });
  document.addEventListener('input',event=>{
    if(event.target.id==='search') { state.query=event.target.value; renderMenu(); }
    else if(event.target.id==='price-range') { state.maxPrice=Number(event.target.value); $('#range-price').textContent=money(state.maxPrice); event.target.setAttribute('aria-valuetext',money(state.maxPrice)); renderMenu(); }
    else if(event.target.id==='order-comment') {
      state.comment=event.target.value.slice(0,1000); saveCart();
      const clear=$('.cart-footer [data-action="clear-cart"]');
      if(clear) clear.disabled=!entries().length&&!state.comment;
    }
  });
  document.addEventListener('change',event=>{ if(event.target.id==='filter-category') setCategory(event.target.value); });
  document.addEventListener('submit',event=>{
    if(event.target.id!=='checkout-form') return;
    event.preventDefault();
    const form=event.target;
    const name=form.elements.name;
    const phone=form.elements.phone;
    name.setCustomValidity(name.value.trim()?'':'Укажите имя.');
    const digits=phone.value.replace(/\D/g,'');
    phone.setCustomValidity(digits.length>=7&&digits.length<=15?'':'Укажите номер телефона: от 7 до 15 цифр.');
    if(!form.reportValidity()) { name.addEventListener('input',()=>name.setCustomValidity(''),{once:true}); phone.addEventListener('input',()=>phone.setCustomValidity(''),{once:true}); return; }
    $('.panel-scroll',content).innerHTML='<div class="checkout-result" role="status">Оплата будет подключена позже.<small>Это демонстрационная форма: заказ не отправлен в кафе. Корзина сохранена, введённые контактные данные никуда не передавались.</small></div><button class="primary-button" style="margin-top:24px" data-action="cart">Вернуться к заказу</button>';
    $('.primary-button',content).focus();
  });
  window.addEventListener('storage',event=>{ if(event.key===config.STORAGE_KEY || event.key===null) { restoreCart(event.newValue); syncOrderSummary(); if(state.panel) renderPanel(true); } });
  async function init() {
    try {
      const response=await fetch('menu.json');
      if(!response.ok) throw new Error('Menu HTTP error');
      state.menu=await response.json();
      if(!Array.isArray(state.menu)||!state.menu.length) throw new Error('Invalid menu');
      categories=[...new Set(state.menu.map(d=>d.category))];
      maxPrice=Math.max(...state.menu.map(d=>d.variants?Math.max(...d.variants.map(v=>v.price)):typeof d.price==='number'?d.price:0));
      state.maxPrice=maxPrice;
      try { restoreCart(localStorage.getItem(config.STORAGE_KEY)); } catch { /* Private mode: session-only cart. */ }
      $$('[data-social]').forEach(link=>{const url=socialURL(link.dataset.social);if(url){link.href=url;link.target='_blank';link.rel='noopener noreferrer';}});
      renderMenu(); syncOrderSummary();
    } catch(error) {
      $('#dish-grid').setAttribute('aria-busy','false'); $('#load-error').hidden=false; $('#result-count').textContent='Нет соединения';
      console.error('Не удалось загрузить меню:',error);
    }
  }
  init();
})();
