// =========================================================================
// QuickBite Express - Full-Stack Client Application
// Connects to REST API and persists orders in database
// Supports external shareable tracking links across all devices & systems
// =========================================================================

const API_BASE = '/api';

// Application State
const state = {
  menu: [],
  cart: [],
  selectedCategory: 'All',
  searchQuery: '',
  vegOnly: false,
  appliedCoupon: null,
  activeOrderId: null,
  trackingPollInterval: null,
  networkInfo: null,
  myOrderIds: JSON.parse(localStorage.getItem('qb_my_orders') || '[]')
};

// =========================================================================
// Audio Chimes (Synthesized via Web Audio API - no external sound files required)
// =========================================================================
function playNotificationSound(type = 'success') {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      // Pleasant rising double chime
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12); // A5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } else if (type === 'pop') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    }
  } catch (e) {
    // Audio context silently ignored if restricted before user gesture
  }
}

// =========================================================================
// Toast Notification
// =========================================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

// =========================================================================
// Resilient API Fetch Helper (Prevents "Failed to fetch" on all deployments)
// =========================================================================
function getEffectiveBaseUrl() {
  const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  // If running on a public domain, cloud host, or tunnel, ALWAYS use current origin
  if (!isLocalHost) {
    return window.location.origin;
  }
  // If on local development, use the discovered network IP so local phones can connect
  return state.networkInfo?.externalUrl || window.location.origin;
}

async function apiFetch(endpoint, options = {}, retries = 1) {
  // Always use clean relative URLs so protocol and host automatically match current window
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  try {
    const res = await fetch(cleanEndpoint, {
      ...options,
      headers: {
        'Accept': 'application/json',
        ...(sessionStorage.getItem('qb_admin_token')
          ? { 'Authorization': `Bearer ${sessionStorage.getItem('qb_admin_token')}` }
          : {}),
        ...(options.headers || {})
      }
    });

    if (!res.ok) {
      let errMsg = `Server returned status ${res.status}`;
      if (res.status === 401 && sessionStorage.getItem('qb_admin_token')) {
        sessionStorage.removeItem('qb_admin_token');
        setAdminAuthenticated(false);
      }
      try {
        const errJson = await res.json();
        errMsg = errJson.error || errJson.message || errMsg;
      } catch (_) {
        const text = await res.text().catch(() => '');
        if (text && text.length < 120) errMsg = text;
      }
      const error = new Error(errMsg);
      error.status = res.status;
      throw error;
    }

    return await res.json();
  } catch (err) {
    // Retry once for transient hiccups or server spin-up
    if (retries > 0 && err.status !== 401 && err.status !== 403) {
      await new Promise(r => setTimeout(r, 1000));
      return apiFetch(endpoint, options, retries - 1);
    }
    console.error(`[API Fetch Error] ${cleanEndpoint}:`, err);
    throw err;
  }
}

// =========================================================================
// Network & External Device Link Initializer
// =========================================================================
async function initNetworkInfo() {
  try {
    const data = await apiFetch(`${API_BASE}/network-info`);
    if (data.success) {
      state.networkInfo = data;
      const networkBadge = document.getElementById('networkUrlBadge');
      if (networkBadge) {
        networkBadge.textContent = getEffectiveBaseUrl();
      }
    }
  } catch (err) {
    console.warn('Network info unavailable, defaulting to origin:', err);
    const networkBadge = document.getElementById('networkUrlBadge');
    if (networkBadge) {
      networkBadge.textContent = window.location.origin;
    }
  }
}

// Copy external link handler
document.getElementById('btnCopyExternalLink')?.addEventListener('click', () => {
  const effectiveUrl = getEffectiveBaseUrl();
  navigator.clipboard.writeText(effectiveUrl);
  showToast(`External link copied: ${effectiveUrl}`, 'success');
  playNotificationSound('pop');
});

// =========================================================================
// Menu Fetching & Rendering
// =========================================================================
async function fetchMenu() {
  const menuGrid = document.getElementById('menuGrid');
  try {
    const params = new URLSearchParams();
    if (state.selectedCategory !== 'All') params.append('category', state.selectedCategory);
    if (state.vegOnly) params.append('vegOnly', 'true');
    if (state.searchQuery.trim()) params.append('search', state.searchQuery.trim());

    const data = await apiFetch(`${API_BASE}/menu?${params.toString()}`);

    if (data.success) {
      state.menu = data.data;
      renderMenu(state.menu);
      updateMenuCountBadge(data.count);
    } else {
      menuGrid.innerHTML = `<div class="loading-spinner"><p>Failed to load menu: ${data.error}</p></div>`;
    }
  } catch (err) {
    console.error('Error fetching menu:', err);
    menuGrid.innerHTML = `
      <div class="loading-spinner">
        <p>Could not connect to backend server. Make sure the server is running on port 5000.</p>
      </div>`;
  }
}

function updateMenuCountBadge(count) {
  const countEl = document.getElementById('menuItemCount');
  if (countEl) {
    const catText = state.selectedCategory === 'All' ? 'all categories' : state.selectedCategory;
    countEl.textContent = `Showing ${count} delicious items in ${catText}`;
  }
}

function renderMenu(items) {
  const menuGrid = document.getElementById('menuGrid');
  if (!menuGrid) return;

  if (items.length === 0) {
    menuGrid.innerHTML = `
      <div class="loading-spinner">
        <div style="font-size: 3rem;">🔍</div>
        <h3>No dishes match your filter</h3>
        <p>Try searching for something else or clear your filters.</p>
      </div>`;
    return;
  }

  menuGrid.innerHTML = items.map(item => {
    const dietaryClass = item.isVeg ? 'veg' : 'non-veg';
    const dietaryLabel = item.isVeg ? '🌱 VEG' : '🥩 NON-VEG';
    const tagHtml = (item.tags && item.tags.length > 0)
      ? `<span class="badge-tag">${item.tags[0]}</span>`
      : '';

    return `
      <article class="food-card" data-id="${item.id}">
        <div class="food-card-img-wrap">
          <span class="badge-dietary ${dietaryClass}">${dietaryLabel}</span>
          ${tagHtml}
          <img src="${item.image}" alt="${item.name}" class="food-card-img" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=80'">
        </div>
        <div class="food-card-body">
          <div class="food-card-meta">
            <span class="food-rating">★ ${item.rating || '4.8'}</span>
            <span>⏱️ ${item.prepTime || '15-20 min'}</span>
          </div>
          <h3 class="food-name">${item.name}</h3>
          <p class="food-desc">${item.description}</p>
          <div class="food-card-footer">
            <span class="food-price">$${Number(item.price).toFixed(2)}</span>
            <button class="btn-add-food" onclick="openItemModal('${item.id}')">
              <span>+ Add</span>
            </button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

// =========================================================================
// Item Customization Modal
// =========================================================================
let currentCustomizingItem = null;
let currentCustomQuantity = 1;

window.openItemModal = function(itemId) {
  const item = state.menu.find(m => m.id === itemId);
  if (!item) return;

  currentCustomizingItem = item;
  currentCustomQuantity = 1;

  const modalBody = document.getElementById('itemModalBody');
  const sizes = item.options?.sizes || [];
  const addons = item.options?.addons || [];
  const spiceLevels = item.options?.spiceLevel || [];

  let sizesHtml = '';
  if (sizes.length > 0) {
    sizesHtml = `
      <div class="custom-section">
        <h4 class="custom-section-title">Select Size</h4>
        <div class="option-group">
          ${sizes.map((s, idx) => `
            <label class="option-label">
              <div>
                <input type="radio" name="modalSize" value="${s.name}" data-extra="${s.extra}" ${idx === 0 ? 'checked' : ''} onchange="updateModalCustomPrice()">
                <span>${s.name}</span>
              </div>
              <span>${s.extra > 0 ? `+$${s.extra.toFixed(2)}` : 'Included'}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }

  let addonsHtml = '';
  if (addons.length > 0) {
    addonsHtml = `
      <div class="custom-section">
        <h4 class="custom-section-title">Optional Add-ons</h4>
        <div class="option-group">
          ${addons.map(a => `
            <label class="option-label">
              <div>
                <input type="checkbox" name="modalAddon" value="${a.name}" data-price="${a.price}" onchange="updateModalCustomPrice()">
                <span>${a.name}</span>
              </div>
              <span>+$${a.price.toFixed(2)}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }

  let spiceHtml = '';
  if (spiceLevels.length > 0) {
    spiceHtml = `
      <div class="custom-section">
        <h4 class="custom-section-title">Spice Level</h4>
        <div class="option-group">
          ${spiceLevels.map((sp, idx) => `
            <label class="option-label">
              <div>
                <input type="radio" name="modalSpice" value="${sp}" ${idx === 0 ? 'checked' : ''}>
                <span>🌶️ ${sp}</span>
              </div>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }

  modalBody.innerHTML = `
    <img src="${item.image}" alt="${item.name}" class="item-modal-img">
    <div class="item-modal-content">
      <div class="food-card-meta">
        <span class="food-rating">★ ${item.rating || '4.8'}</span>
        <span>⏱️ ${item.prepTime || '15-20 min'}</span>
        <span>🔥 ${item.calories || '550 kcal'}</span>
      </div>
      <h2 style="font-family: var(--font-heading); margin-bottom: 8px;">${item.name}</h2>
      <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 16px;">${item.description}</p>
      
      ${sizesHtml}
      ${addonsHtml}
      ${spiceHtml}

      <div class="modal-add-bar">
        <div class="quantity-control">
          <button class="qty-btn" onclick="changeModalQty(-1)">-</button>
          <span class="qty-val" id="modalQtyDisplay">1</span>
          <button class="qty-btn" onclick="changeModalQty(1)">+</button>
        </div>
        <button class="btn-confirm-add" id="btnConfirmAddToCart" onclick="confirmAddToCart()">
          Add to Cart • <span id="modalFinalPrice">$${Number(item.price).toFixed(2)}</span>
        </button>
      </div>
    </div>
  `;

  document.getElementById('itemModalOverlay').style.display = 'flex';
  updateModalCustomPrice();
};

window.changeModalQty = function(delta) {
  currentCustomQuantity = Math.max(1, currentCustomQuantity + delta);
  const qtyEl = document.getElementById('modalQtyDisplay');
  if (qtyEl) qtyEl.textContent = currentCustomQuantity;
  updateModalCustomPrice();
};

window.updateModalCustomPrice = function() {
  if (!currentCustomizingItem) return;
  let base = Number(currentCustomizingItem.price);

  const selectedSize = document.querySelector('input[name="modalSize"]:checked');
  if (selectedSize) {
    base += Number(selectedSize.dataset.extra || 0);
  }

  const selectedAddons = document.querySelectorAll('input[name="modalAddon"]:checked');
  selectedAddons.forEach(a => {
    base += Number(a.dataset.price || 0);
  });

  const total = base * currentCustomQuantity;
  const priceEl = document.getElementById('modalFinalPrice');
  if (priceEl) priceEl.textContent = `$${total.toFixed(2)}`;
};

window.confirmAddToCart = function() {
  if (!currentCustomizingItem) return;

  const selectedSizeInput = document.querySelector('input[name="modalSize"]:checked');
  const selectedSize = selectedSizeInput ? selectedSizeInput.value : null;
  const sizeExtra = selectedSizeInput ? Number(selectedSizeInput.dataset.extra || 0) : 0;

  const addonInputs = document.querySelectorAll('input[name="modalAddon"]:checked');
  const selectedAddons = [];
  let addonsCost = 0;
  addonInputs.forEach(a => {
    selectedAddons.push(a.value);
    addonsCost += Number(a.dataset.price || 0);
  });

  const spiceInput = document.querySelector('input[name="modalSpice"]:checked');
  const spiceLevel = spiceInput ? spiceInput.value : null;

  const unitPrice = Number(currentCustomizingItem.price) + sizeExtra + addonsCost;
  const itemTotal = unitPrice * currentCustomQuantity;

  // Add to cart state
  state.cart.push({
    id: currentCustomizingItem.id,
    cartItemId: `citem-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    name: currentCustomizingItem.name,
    price: unitPrice,
    basePrice: Number(currentCustomizingItem.price),
    quantity: currentCustomQuantity,
    selectedSize,
    selectedAddons,
    spiceLevel,
    itemTotal
  });

  saveCart();
  renderCart();
  closeModal('itemModalOverlay');
  showToast(`Added ${currentCustomizingItem.name} to cart!`, 'success');
  playNotificationSound('pop');
};

function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.style.display = 'none';
}

document.getElementById('closeItemModal')?.addEventListener('click', () => closeModal('itemModalOverlay'));
document.getElementById('itemModalOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'itemModalOverlay') closeModal('itemModalOverlay');
});

// =========================================================================
// Cart Management & Drawer
// =========================================================================
function saveCart() {
  localStorage.setItem('qb_cart', JSON.stringify(state.cart));
}

function loadCart() {
  const saved = localStorage.getItem('qb_cart');
  if (saved) {
    try {
      state.cart = JSON.parse(saved);
    } catch (e) {
      state.cart = [];
    }
  }
}

function renderCart() {
  const cartBadge = document.getElementById('cartCountBadge');
  const headerTotal = document.getElementById('cartHeaderTotal');
  const drawerCount = document.getElementById('drawerItemCount');
  const itemsList = document.getElementById('drawerItemsList');

  const totalItemsCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  if (cartBadge) cartBadge.textContent = totalItemsCount;
  if (headerTotal) headerTotal.textContent = `$${subtotal.toFixed(2)}`;
  if (drawerCount) drawerCount.textContent = `${totalItemsCount} item${totalItemsCount === 1 ? '' : 's'}`;

  if (!itemsList) return;

  if (state.cart.length === 0) {
    itemsList.innerHTML = `
      <div class="empty-cart-state">
        <span class="empty-cart-emoji">🛒</span>
        <h3>Your Cart is Hungry!</h3>
        <p>Explore our menu and add something delicious.</p>
      </div>
    `;
    updateBillCalculations(0);
    return;
  }

  itemsList.innerHTML = state.cart.map(item => {
    const customizations = [];
    if (item.selectedSize) customizations.push(`Size: ${item.selectedSize}`);
    if (item.spiceLevel) customizations.push(`Spice: ${item.spiceLevel}`);
    if (item.selectedAddons && item.selectedAddons.length > 0) {
      customizations.push(`Add-ons: ${item.selectedAddons.join(', ')}`);
    }

    const customText = customizations.join(' • ');

    return `
      <div class="cart-item-card">
        <div class="cart-item-info">
          <div class="cart-item-title">${item.name}</div>
          ${customText ? `<div class="cart-item-sub">${customText}</div>` : ''}
          <div class="cart-item-price">$${(item.price * item.quantity).toFixed(2)}</div>
        </div>
        <div class="quantity-control">
          <button class="qty-btn" onclick="updateCartItemQty('${item.cartItemId}', -1)">-</button>
          <span class="qty-val">${item.quantity}</span>
          <button class="qty-btn" onclick="updateCartItemQty('${item.cartItemId}', 1)">+</button>
        </div>
      </div>
    `;
  }).join('');

  updateBillCalculations(subtotal);
}

window.updateCartItemQty = function(cartItemId, delta) {
  const idx = state.cart.findIndex(i => i.cartItemId === cartItemId);
  if (idx === -1) return;

  state.cart[idx].quantity += delta;
  if (state.cart[idx].quantity <= 0) {
    state.cart.splice(idx, 1);
  }

  saveCart();
  renderCart();
};

function updateBillCalculations(subtotal) {
  let deliveryFee = subtotal > 0 ? 3.99 : 0;
  let discount = 0;

  if (state.appliedCoupon && subtotal > 0) {
    discount = state.appliedCoupon.discount || 0;
    if (state.appliedCoupon.freeDelivery) {
      deliveryFee = 0;
    }
  }

  const tax = subtotal > 0 ? Number((subtotal * 0.08).toFixed(2)) : 0;
  const grandTotal = Math.max(0, subtotal - discount + deliveryFee + tax);

  document.getElementById('billSubtotal').textContent = `$${subtotal.toFixed(2)}`;
  document.getElementById('billDelivery').textContent = deliveryFee === 0 ? 'FREE' : `$${deliveryFee.toFixed(2)}`;
  document.getElementById('billTax').textContent = `$${tax.toFixed(2)}`;
  document.getElementById('billGrandTotal').textContent = `$${grandTotal.toFixed(2)}`;

  const discountRow = document.getElementById('billDiscountRow');
  if (discount > 0 && discountRow) {
    discountRow.style.display = 'flex';
    document.getElementById('billDiscountCode').textContent = state.appliedCoupon.code;
    document.getElementById('billDiscountAmount').textContent = `-$${discount.toFixed(2)}`;
  } else if (discountRow) {
    discountRow.style.display = 'none';
  }

  return { subtotal, discount, deliveryFee, tax, grandTotal };
}

// Drawer open/close
document.getElementById('btnCartDrawer')?.addEventListener('click', () => {
  document.getElementById('cartDrawerOverlay').style.display = 'flex';
});

document.getElementById('closeCartDrawer')?.addEventListener('click', () => {
  document.getElementById('cartDrawerOverlay').style.display = 'none';
});

document.getElementById('cartDrawerOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'cartDrawerOverlay') {
    document.getElementById('cartDrawerOverlay').style.display = 'none';
  }
});

// Coupon Application
document.getElementById('btnApplyCoupon')?.addEventListener('click', async () => {
  const input = document.getElementById('couponInput');
  const feedback = document.getElementById('couponFeedback');
  const code = (input.value || '').trim();

  if (!code) {
    feedback.className = 'coupon-feedback error';
    feedback.textContent = 'Please enter a coupon code';
    return;
  }

  const subtotal = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  if (subtotal <= 0) {
    feedback.className = 'coupon-feedback error';
    feedback.textContent = 'Add items to your cart before applying a coupon';
    return;
  }

  try {
    const data = await apiFetch(`${API_BASE}/coupons/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, subtotal })
    });

    if (data.valid) {
      state.appliedCoupon = data;
      feedback.className = 'coupon-feedback success';
      feedback.textContent = `Applied! ${data.description}`;
      renderCart();
      showToast(`Promo ${data.code} applied!`, 'success');
      playNotificationSound('pop');
    } else {
      feedback.className = 'coupon-feedback error';
      feedback.textContent = data.message || 'Invalid coupon code';
      state.appliedCoupon = null;
      renderCart();
    }
  } catch (err) {
    feedback.className = 'coupon-feedback error';
    feedback.textContent = 'Failed to validate coupon';
  }
});

// Hero coupon quick apply
document.getElementById('btnApplyHeroCoupon')?.addEventListener('click', () => {
  const couponInput = document.getElementById('couponInput');
  if (couponInput) couponInput.value = 'TASTY20';
  document.getElementById('cartDrawerOverlay').style.display = 'flex';
  document.getElementById('btnApplyCoupon')?.click();
});

// =========================================================================
// Checkout & Order Creation (Connected to Backend REST API & DB)
// =========================================================================
document.getElementById('btnProceedCheckout')?.addEventListener('click', () => {
  if (state.cart.length === 0) {
    showToast('Your cart is empty!', 'error');
    return;
  }
  document.getElementById('cartDrawerOverlay').style.display = 'none';

  const subtotal = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const bill = updateBillCalculations(subtotal);

  document.getElementById('checkoutTotalAmount').textContent = `$${bill.grandTotal.toFixed(2)}`;
  document.getElementById('checkoutModalOverlay').style.display = 'flex';
});

document.getElementById('closeCheckoutModal')?.addEventListener('click', () => {
  document.getElementById('checkoutModalOverlay').style.display = 'none';
});

// Payment option radio highlight
document.querySelectorAll('input[name="payMethod"]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('.payment-card').forEach(c => c.classList.remove('selected'));
    radio.closest('.payment-card')?.classList.add('selected');
  });
});

// Submit Order
document.getElementById('checkoutForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('custName').value.trim();
  const phone = document.getElementById('custPhone').value.trim();
  const email = document.getElementById('custEmail').value.trim();
  const address = document.getElementById('custAddress').value.trim();
  const notes = document.getElementById('orderNotes').value.trim();
  const paymentMethod = document.querySelector('input[name="payMethod"]:checked')?.value || 'Cash on Delivery';

  if (!name || !phone || !address) {
    showToast('Please fill out all required fields marked *', 'error');
    return;
  }

  const subtotal = state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const bill = updateBillCalculations(subtotal);

  const orderPayload = {
    customer: { name, phone, email, address },
    items: state.cart.map(item => ({
      id: item.id,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      selectedSize: item.selectedSize,
      selectedAddons: item.selectedAddons,
      itemTotal: item.price * item.quantity
    })),
    subtotal: bill.subtotal,
    tax: bill.tax,
    deliveryFee: bill.deliveryFee,
    discount: bill.discount,
    couponCode: state.appliedCoupon ? state.appliedCoupon.code : null,
    total: bill.grandTotal,
    paymentMethod,
    notes
  };

  const submitBtn = document.getElementById('btnPlaceOrderSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Processing Order...';

  try {
    const result = await apiFetch(`${API_BASE}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload)
    });

    if (result.success) {
      const newOrder = result.data;

      // Save order id to local storage
      state.myOrderIds.unshift(newOrder.id);
      localStorage.setItem('qb_my_orders', JSON.stringify(state.myOrderIds));
      updateActiveOrdersNavBadge();

      // Clear cart
      state.cart = [];
      state.appliedCoupon = null;
      saveCart();
      renderCart();

      // Close checkout
      document.getElementById('checkoutModalOverlay').style.display = 'none';

      // Chime and toast
      playNotificationSound('success');
      showToast(`🎉 Order ${newOrder.id} successfully placed!`, 'success');

      // Launch Live Tracking Screen
      openLiveTrackingModal(newOrder.id);
    } else {
      showToast(result.error || 'Failed to place order', 'error');
    }
  } catch (err) {
    console.error('Error submitting order:', err);
    showToast('Failed to connect to order server', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Place Order Now 🚀';
  }
});

// =========================================================================
// LIVE ORDER TRACKING & EXTERNAL SHAREABLE LINK
// Core Requirement: Shareable external link visible in any other systems!
// =========================================================================
window.openLiveTrackingModal = async function(orderId) {
  state.activeOrderId = orderId;
  const modal = document.getElementById('trackingModalOverlay');
  if (modal) modal.style.display = 'flex';

  await refreshLiveTrackingData(orderId);

  // Start polling every 4 seconds to catch kitchen status changes in real time
  if (state.trackingPollInterval) clearInterval(state.trackingPollInterval);
  state.trackingPollInterval = setInterval(() => {
    if (state.activeOrderId) {
      refreshLiveTrackingData(state.activeOrderId, true);
    }
  }, 4000);
};

async function refreshLiveTrackingData(orderId, silent = false) {
  try {
    const data = await apiFetch(`${API_BASE}/orders/${orderId}`);

    if (!data.success || !data.data) {
      if (!silent) showToast(`Order ${orderId} not found`, 'error');
      return;
    }

    const order = data.data;
    renderTrackingScreen(order);
  } catch (err) {
    if (!silent) console.error('Failed to poll order status:', err);
  }
}

function renderTrackingScreen(order) {
  document.getElementById('trackOrderId').textContent = order.id;

  // Compute External Shareable URL using effective public base
  const host = getEffectiveBaseUrl();
  const shareableUrl = `${host}/?track=${order.id}`;

  const shareInput = document.getElementById('shareableLinkInput');
  if (shareInput) shareInput.value = shareableUrl;

  // Stepper logic
  const statuses = ['Placed', 'Preparing', 'Out for Delivery', 'Delivered'];
  const currentIndex = statuses.indexOf(order.status);

  const fillEl = document.getElementById('stepperProgressFill');
  const nodes = {
    Placed: document.getElementById('stepNodePlaced'),
    Preparing: document.getElementById('stepNodePreparing'),
    'Out for Delivery': document.getElementById('stepNodeOut'),
    Delivered: document.getElementById('stepNodeDelivered')
  };

  // Reset node classes
  Object.values(nodes).forEach(node => {
    if (node) {
      node.classList.remove('active', 'completed');
    }
  });

  statuses.forEach((status, idx) => {
    const node = nodes[status];
    if (!node) return;
    if (idx < currentIndex) {
      node.classList.add('completed');
    } else if (idx === currentIndex) {
      node.classList.add('active');
    }
  });

  // Calculate percentage fill
  const progressPercent = Math.max(15, Math.min(100, ((currentIndex + 1) / statuses.length) * 100));
  if (fillEl) fillEl.style.width = `${progressPercent}%`;

  // Status banner information
  const statusTitle = document.getElementById('trackingStatusTitle');
  const statusDesc = document.getElementById('trackingStatusDesc');
  const etaTime = document.getElementById('trackingEtaTime');
  const iconWrap = document.getElementById('statusIconWrap');

  if (order.status === 'Placed') {
    statusTitle.textContent = 'Order Received by Restaurant';
    statusDesc.textContent = 'Your order is confirmed and sent to the head chef.';
    etaTime.textContent = '28-30 min';
    iconWrap.textContent = '📝';
  } else if (order.status === 'Preparing') {
    statusTitle.textContent = 'Chef is Preparing Your Food';
    statusDesc.textContent = 'Sizzling hot and made to order with fresh ingredients.';
    etaTime.textContent = '18-20 min';
    iconWrap.textContent = '👨‍🍳';
  } else if (order.status === 'Out for Delivery') {
    statusTitle.textContent = 'Courier is on the Way!';
    statusDesc.textContent = `${order.driver?.name || 'Driver'} picked up your package on an electric scooter.`;
    etaTime.textContent = '8-10 min';
    iconWrap.textContent = '🛵';
  } else if (order.status === 'Delivered') {
    statusTitle.textContent = 'Food Successfully Delivered!';
    statusDesc.textContent = 'Thank you for choosing QuickBite Express. Enjoy your meal!';
    etaTime.textContent = 'Delivered 🎉';
    iconWrap.textContent = '🏠';
  } else if (order.status === 'Cancelled') {
    statusTitle.textContent = 'Order Cancelled';
    statusDesc.textContent = 'This order has been cancelled.';
    etaTime.textContent = 'Cancelled';
    iconWrap.textContent = '❌';
  }

  // Driver & Customer Meta
  document.getElementById('trackDriverName').textContent = order.driver?.name || 'Carlos Mendez';
  document.getElementById('trackDriverVehicle').textContent = `${order.driver?.vehicle || 'Delivery Scooter'} • 4.9 ★`;
  document.getElementById('trackCustName').textContent = 'Customer details protected';
  document.getElementById('trackCustAddress').textContent = 'Visible only to the restaurant';
  document.getElementById('trackOrderNotes').textContent = 'Delivery instructions stay private.';

  // Ordered items summary
  const itemsContainer = document.getElementById('trackItemsList');
  if (itemsContainer && order.items) {
    itemsContainer.innerHTML = order.items.map(item => `
      <div class="ordered-item-row">
        <span><strong>${escapeHtml(item.quantity)}x</strong> ${escapeHtml(item.name)} ${item.selectedSize ? `(${escapeHtml(item.selectedSize)})` : ''}</span>
        <strong>$${Number(item.itemTotal || (item.price * item.quantity)).toFixed(2)}</strong>
      </div>
    `).join('');
  }

  document.getElementById('trackPayMethod').textContent = 'Payment details kept private';
  document.getElementById('trackOrderTotal').textContent = `$${Number(order.total).toFixed(2)}`;
}

// Shareable Link Copy Button
document.getElementById('btnCopyShareableLink')?.addEventListener('click', () => {
  const input = document.getElementById('shareableLinkInput');
  if (input && input.value) {
    navigator.clipboard.writeText(input.value);
    showToast('External link copied! Open it on any phone or other computer.', 'success');
    playNotificationSound('pop');
  }
});

document.getElementById('closeTrackingModal')?.addEventListener('click', () => {
  document.getElementById('trackingModalOverlay').style.display = 'none';
  if (state.trackingPollInterval) {
    clearInterval(state.trackingPollInterval);
    state.trackingPollInterval = null;
  }
  state.activeOrderId = null;
});

// =========================================================================
// Orders History Modal
// =========================================================================
document.getElementById('btnMyOrders')?.addEventListener('click', async () => {
  document.getElementById('ordersHistoryOverlay').style.display = 'flex';
  await renderOrderHistory();
});

document.getElementById('closeHistoryModal')?.addEventListener('click', () => {
  document.getElementById('ordersHistoryOverlay').style.display = 'none';
});

async function renderOrderHistory() {
  const container = document.getElementById('historyListContainer');
  try {
    const orderIds = [...new Set(state.myOrderIds.filter(id => typeof id === 'string'))].slice(0, 20);
    const orderResults = await Promise.all(orderIds.map(async id => {
      try {
        const result = await apiFetch(`${API_BASE}/orders/${encodeURIComponent(id)}`);
        return result.success ? result.data : null;
      } catch (err) {
        if (err.status !== 404) console.error(`Failed to load order ${id}:`, err);
        return null;
      }
    }));
    const orders = orderResults.filter(Boolean);

    if (orders.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <div style="font-size: 3rem;">📦</div>
          <h3>No Orders Yet</h3>
          <p>When you place an order, you can review and track it here.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = orders.map(order => {
      const dateStr = new Date(order.createdAt).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const itemsSummary = (order.items || []).map(i => `${escapeHtml(i.quantity)}x ${escapeHtml(i.name)}`).join(', ');
      const statusClass = escapeHtml((order.status || 'Placed').replace(/\s+/g, '-'));

      return `
        <div class="history-order-card">
          <div class="hoc-header">
            <div>
              <span class="hoc-id">${escapeHtml(order.id)}</span>
              <span class="hoc-date">• ${dateStr}</span>
            </div>
            <span class="status-pill ${statusClass}">${escapeHtml(order.status)}</span>
          </div>
          <div class="hoc-items">${itemsSummary}</div>
          <div class="hoc-footer">
            <span class="hoc-total">$${Number(order.total).toFixed(2)}</span>
            <button class="btn-hoc-track" onclick="openLiveTrackingModal('${escapeHtml(order.id)}'); document.getElementById('ordersHistoryOverlay').style.display='none';">
              Live Track 🛵
            </button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p>Error loading order history: ${err.message}</p>`;
  }
}

function updateActiveOrdersNavBadge() {
  const badge = document.getElementById('navOrdersBadge');
  if (badge) {
    const count = state.myOrderIds.length;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

// =========================================================================
// Kitchen & Restaurant Admin Portal
// Change order status live & Add items to menu
// =========================================================================
function setAdminAuthenticated(authenticated) {
  const loginView = document.getElementById('adminLoginView');
  const dashboardView = document.getElementById('adminDashboardView');
  const logoutButton = document.getElementById('adminLogout');
  if (loginView) loginView.style.display = authenticated ? 'none' : 'block';
  if (dashboardView) dashboardView.style.display = authenticated ? 'block' : 'none';
  if (logoutButton) logoutButton.hidden = !authenticated;
}

document.getElementById('btnKitchenAdmin')?.addEventListener('click', async () => {
  document.getElementById('adminModalOverlay').style.display = 'flex';
  const authenticated = Boolean(sessionStorage.getItem('qb_admin_token'));
  setAdminAuthenticated(authenticated);
  if (authenticated) {
    await refreshAdminDashboard();
  } else {
    document.getElementById('adminPasswordInput').focus();
  }
});

document.getElementById('adminLoginForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const passwordInput = document.getElementById('adminPasswordInput');
  const errorMessage = document.getElementById('adminLoginError');
  const submitButton = document.getElementById('adminLoginSubmit');
  submitButton.disabled = true;
  errorMessage.textContent = '';

  try {
    const result = await apiFetch(`${API_BASE}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value })
    });
    sessionStorage.setItem('qb_admin_token', result.token);
    passwordInput.value = '';
    setAdminAuthenticated(true);
    await refreshAdminDashboard();
  } catch (err) {
    errorMessage.textContent = err.message;
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById('adminLogout')?.addEventListener('click', async () => {
  try {
    await apiFetch(`${API_BASE}/admin/logout`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to invalidate admin session:', err);
  } finally {
    sessionStorage.removeItem('qb_admin_token');
    setAdminAuthenticated(false);
    document.getElementById('adminPasswordInput').focus();
  }
});

document.getElementById('closeAdminModal')?.addEventListener('click', () => {
  document.getElementById('adminModalOverlay').style.display = 'none';
});

// Admin Tab switcher
document.getElementById('tabAdminOrders')?.addEventListener('click', () => {
  document.getElementById('tabAdminOrders').classList.add('active');
  document.getElementById('tabAdminMenu').classList.remove('active');
  document.getElementById('adminOrdersView').style.display = 'block';
  document.getElementById('adminMenuView').style.display = 'none';
});

document.getElementById('tabAdminMenu')?.addEventListener('click', () => {
  document.getElementById('tabAdminMenu').classList.add('active');
  document.getElementById('tabAdminOrders').classList.remove('active');
  document.getElementById('adminMenuView').style.display = 'block';
  document.getElementById('adminOrdersView').style.display = 'none';
});

async function refreshAdminDashboard() {
  await Promise.all([refreshAdminStats(), refreshAdminOrdersTable(), refreshAdminMenuList()]);
}

async function refreshAdminStats() {
  try {
    const data = await apiFetch(`${API_BASE}/admin/stats`);
    if (data.success) {
      document.getElementById('kpiRevenue').textContent = `$${data.data.totalRevenue.toFixed(2)}`;
      document.getElementById('kpiOrders').textContent = data.data.totalOrders;
      document.getElementById('kpiActive').textContent = data.data.activeOrders;
      document.getElementById('kpiMenu').textContent = data.data.totalMenuItems;
    }
  } catch (e) {
    console.error('Error fetching admin stats:', e);
  }
}

async function refreshAdminOrdersTable() {
  const tbody = document.getElementById('adminOrdersTableBody');
  try {
    const data = await apiFetch(`${API_BASE}/orders`);

    if (!data.success || !data.data || data.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:20px;">No orders found</td></tr>`;
      return;
    }

    const statuses = ['Placed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];

    tbody.innerHTML = data.data.map(o => {
      const itemsList = (o.items || []).map(i => `${escapeHtml(i.quantity)}x ${escapeHtml(i.name)}`).join('<br>');
      const statusClass = escapeHtml((o.status || 'Placed').replace(/\s+/g, '-'));

      return `
        <tr>
          <td><strong>${escapeHtml(o.id)}</strong></td>
          <td>
            <strong>${escapeHtml(o.customer?.name || 'Guest')}</strong><br>
            <small style="color:var(--text-muted)">${escapeHtml(o.customer?.phone || '')}</small>
          </td>
          <td><small>${itemsList}</small></td>
          <td><strong>$${Number(o.total).toFixed(2)}</strong></td>
          <td><span class="status-pill ${statusClass}">${escapeHtml(o.status)}</span></td>
          <td>
            <select class="select-status-admin" onchange="changeOrderStatusFromAdmin('${escapeHtml(o.id)}', this.value)">
              ${statuses.map(s => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </td>
          <td>
            <button class="btn-hoc-track" onclick="openLiveTrackingModal('${escapeHtml(o.id)}')">View</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7">Error loading orders</td></tr>`;
  }
}

window.changeOrderStatusFromAdmin = async function(orderId, newStatus) {
  try {
    const data = await apiFetch(`${API_BASE}/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });

    if (data.success) {
      showToast(`Order ${orderId} updated to ${newStatus}`, 'success');
      playNotificationSound('pop');
      await refreshAdminDashboard();

      // If this order is open in the tracker, update it immediately
      if (state.activeOrderId === orderId) {
        renderTrackingScreen(data.data);
      }
    } else {
      showToast(data.error || 'Failed to update order', 'error');
    }
  } catch (e) {
    showToast('Failed to connect to server', 'error');
  }
};

async function refreshAdminMenuList() {
  const container = document.getElementById('adminDishList');
  const countBadge = document.getElementById('adminLiveMenuCount');
  try {
    const data = await apiFetch(`${API_BASE}/menu`);

    if (data.success) {
      if (countBadge) countBadge.textContent = data.data.length;
      container.innerHTML = data.data.map(item => `
        <div class="admin-dish-row">
          <div>
            <strong>${escapeHtml(item.name)}</strong> • <span style="color:var(--primary); font-weight:700;">$${Number(item.price).toFixed(2)}</span>
              <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(item.category)} • ${item.isVeg ? '🌱 Veg' : '🥩 Non-Veg'}</div>
          </div>
            <button class="btn-del-dish" onclick="deleteMenuDish('${escapeHtml(item.id)}')">Delete</button>
        </div>
      `).join('');
    }
  } catch (e) {
    container.innerHTML = '<p>Error loading dishes</p>';
  }
}

window.deleteMenuDish = async function(itemId) {
  if (!confirm('Are you sure you want to delete this dish from the menu?')) return;
  try {
    const data = await apiFetch(`${API_BASE}/menu/${itemId}`, { method: 'DELETE' });
    if (data.success) {
      showToast('Dish deleted from menu', 'success');
      await refreshAdminMenuList();
      await fetchMenu();
    }
  } catch (e) {
    showToast('Error deleting dish', 'error');
  }
};

// Add New Dish to Menu Form
document.getElementById('addMenuDishForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('newDishName').value.trim();
  const category = document.getElementById('newDishCategory').value;
  const price = parseFloat(document.getElementById('newDishPrice').value);
  const description = document.getElementById('newDishDesc').value.trim();
  const image = document.getElementById('newDishImage').value.trim();
  const prepTime = document.getElementById('newDishPrep').value.trim() || '15-20 min';
  const isVeg = document.getElementById('newDishVeg').checked;

  try {
    const data = await apiFetch(`${API_BASE}/menu`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        category,
        price,
        description,
        image: image || undefined,
        prepTime,
        isVeg
      })
    });

    if (data.success) {
      showToast(`Added ${data.data.name} to menu!`, 'success');
      playNotificationSound('pop');
      document.getElementById('addMenuDishForm').reset();
      await refreshAdminMenuList();
      await fetchMenu();
    } else {
      showToast(data.error || 'Failed to add dish', 'error');
    }
  } catch (err) {
    showToast('Failed to add dish', 'error');
  }
});

// =========================================================================
// Category & Search Filters
// =========================================================================
document.querySelectorAll('.cat-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedCategory = btn.dataset.category;
    fetchMenu();
  });
});

const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');

searchInput?.addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  if (state.searchQuery.length > 0) {
    searchClearBtn.style.display = 'block';
  } else {
    searchClearBtn.style.display = 'none';
  }
  fetchMenu();
});

searchClearBtn?.addEventListener('click', () => {
  searchInput.value = '';
  state.searchQuery = '';
  searchClearBtn.style.display = 'none';
  fetchMenu();
});

document.getElementById('vegFilterToggle')?.addEventListener('change', (e) => {
  state.vegOnly = e.target.checked;
  fetchMenu();
});

// Logo resets filters
document.getElementById('brandLogo')?.addEventListener('click', () => {
  state.selectedCategory = 'All';
  state.searchQuery = '';
  state.vegOnly = false;
  if (searchInput) searchInput.value = '';
  if (searchClearBtn) searchClearBtn.style.display = 'none';
  const vegToggle = document.getElementById('vegFilterToggle');
  if (vegToggle) vegToggle.checked = false;
  document.querySelectorAll('.cat-pill').forEach(b => {
    b.classList.toggle('active', b.dataset.category === 'All');
  });
  fetchMenu();
});

// =========================================================================
// App Bootstrap & Direct URL Tracker check (e.g. ?track=ORD-5401)
// =========================================================================
async function bootstrapApp() {
  loadCart();
  renderCart();
  updateActiveOrdersNavBadge();
  await initNetworkInfo();
  await fetchMenu();

  // Check if someone opened this page directly with ?track=ORD-XXXX
  // This allows external systems/phones to jump straight to the live tracker!
  const urlParams = new URLSearchParams(window.location.search);
  const trackParam = urlParams.get('track');
  if (trackParam) {
    console.log(`Direct tracking requested for ${trackParam}`);
    openLiveTrackingModal(trackParam);
  }
}

document.addEventListener('DOMContentLoaded', bootstrapApp);
