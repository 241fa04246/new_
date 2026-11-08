import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const INITIAL_MENU_FILE = path.join(__dirname, '..', 'data', 'initialMenu.json');

const INITIAL_COUPONS = [
  { code: 'TASTY20', type: 'percent', value: 20, description: '20% off your entire order' },
  { code: 'FREEDEL', type: 'flat_delivery', value: 3.99, description: 'Free Delivery' },
  { code: 'YUMMY5', type: 'flat', value: 5.0, minOrder: 25, description: '$5 off on orders over $25' }
];

let cachedData = null;

async function initDb() {
  if (cachedData) return cachedData;
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    cachedData = JSON.parse(raw);
  } catch (err) {
    let initialMenu = [];
    try {
      const rawInitial = await fs.readFile(INITIAL_MENU_FILE, 'utf8');
      initialMenu = JSON.parse(rawInitial);
    } catch (e) {
      initialMenu = [];
    }

    cachedData = {
      menu: initialMenu,
      orders: [
        {
          id: 'ORD-7821',
          customer: {
            name: 'Alex Johnson',
            email: 'alex@example.com',
            phone: '+1 (555) 234-5678',
            address: '742 Evergreen Terrace, Apt 4B, Springfield'
          },
          items: [
            {
              id: 'item-1',
              name: 'Truffle Smash Double Burger',
              price: 14.99,
              quantity: 2,
              selectedSize: 'Regular',
              selectedAddons: ['Extra Truffle Aioli'],
              itemTotal: 32.48
            },
            {
              id: 'item-9',
              name: 'Mango Passion Fruit Craft Boba',
              price: 6.25,
              quantity: 2,
              selectedSize: null,
              selectedAddons: [],
              itemTotal: 12.50
            }
          ],
          subtotal: 44.98,
          tax: 3.60,
          deliveryFee: 3.99,
          discount: 0,
          couponCode: null,
          total: 52.57,
          paymentMethod: 'Credit Card (Stripe Mock)',
          paymentStatus: 'Paid',
          status: 'Preparing', // 'Placed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'
          notes: 'Leave at front door ring bell please',
          createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
          estimatedDeliveryMinutes: 25
        }
      ],
      coupons: INITIAL_COUPONS
    };
    await saveDb();
  }
  return cachedData;
}

async function saveDb() {
  const tempFile = `${DB_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(cachedData, null, 2), 'utf8');
  await fs.rename(tempFile, DB_FILE);
}

export const dbService = {
  async getMenu() {
    await initDb();
    return cachedData.menu;
  },

  async getMenuItemById(id) {
    await initDb();
    return cachedData.menu.find(m => m.id === id);
  },

  async addMenuItem(itemData) {
    await initDb();
    const newItem = {
      id: `item-${Date.now()}`,
      rating: 5.0,
      tags: itemData.tags || [],
      ...itemData,
      price: Number(itemData.price)
    };
    cachedData.menu.unshift(newItem);
    await saveDb();
    return newItem;
  },

  async updateMenuItem(id, updates) {
    await initDb();
    const idx = cachedData.menu.findIndex(m => m.id === id);
    if (idx === -1) return null;
    cachedData.menu[idx] = { ...cachedData.menu[idx], ...updates };
    if (updates.price) cachedData.menu[idx].price = Number(updates.price);
    await saveDb();
    return cachedData.menu[idx];
  },

  async deleteMenuItem(id) {
    await initDb();
    const idx = cachedData.menu.findIndex(m => m.id === id);
    if (idx === -1) return false;
    cachedData.menu.splice(idx, 1);
    await saveDb();
    return true;
  },

  async getOrders() {
    await initDb();
    return cachedData.orders;
  },

  async getOrderById(id) {
    await initDb();
    return cachedData.orders.find(o => o.id === id);
  },

  async createOrder(orderPayload) {
    await initDb();
    const orderId = `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
    const newOrder = {
      id: orderId,
      ...orderPayload,
      status: 'Placed',
      createdAt: new Date().toISOString(),
      estimatedDeliveryMinutes: 30
    };
    cachedData.orders.unshift(newOrder);
    await saveDb();
    return newOrder;
  },

  async updateOrderStatus(id, status) {
    await initDb();
    const order = cachedData.orders.find(o => o.id === id);
    if (!order) return null;
    order.status = status;
    order.updatedAt = new Date().toISOString();
    await saveDb();
    return order;
  },

  async getCoupons() {
    await initDb();
    return cachedData.coupons;
  },

  async validateCoupon(code, subtotal) {
    await initDb();
    const coupon = cachedData.coupons.find(c => c.code.toUpperCase() === code.trim().toUpperCase());
    if (!coupon) {
      return { valid: false, message: 'Invalid promo code' };
    }
    if (coupon.minOrder && subtotal < coupon.minOrder) {
      return { valid: false, message: `Minimum order of $${coupon.minOrder.toFixed(2)} required for this coupon` };
    }
    let discount = 0;
    let freeDelivery = false;
    if (coupon.type === 'percent') {
      discount = (subtotal * coupon.value) / 100;
    } else if (coupon.type === 'flat') {
      discount = coupon.value;
    } else if (coupon.type === 'flat_delivery') {
      freeDelivery = true;
      discount = coupon.value;
    }
    return {
      valid: true,
      code: coupon.code,
      discount: Number(discount.toFixed(2)),
      freeDelivery,
      description: coupon.description
    };
  },

  async getStats() {
    await initDb();
    const totalOrders = cachedData.orders.length;
    const totalRevenue = cachedData.orders
      .filter(o => o.status !== 'Cancelled')
      .reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const activeOrders = cachedData.orders.filter(o => o.status !== 'Delivered' && o.status !== 'Cancelled').length;
    const totalItems = cachedData.menu.length;
    return {
      totalOrders,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      activeOrders,
      totalMenuItems: totalItems
    };
  }
};
