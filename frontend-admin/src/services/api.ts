import axios from 'axios'
import { message } from 'antd'
import type {
  User, Product, Auction, Bid, Order, DashboardStats, TopProductRow,
} from '../types'

const api = axios.create({ baseURL: '/api', timeout: 10000 })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status
    if (status === 401) {
      localStorage.removeItem('admin_token')
      window.location.href = '/login'
    } else if (status === 403) {
      message.error('权限不足')
    } else if (status >= 500) {
      message.error('服务器错误，请稍后重试')
    }
    return Promise.reject(err)
  },
)

export const login = (data: { email: string; password: string }) =>
  api.post<{ token: string; user: User }>('/login', data).then((r) => r.data)

export const register = (data: { username: string; email: string; password: string; role: 'seller' }) =>
  api.post<{ token: string; user: User }>('/register', data).then((r) => r.data)

export const getMe = () => api.get<User>('/me').then((r) => r.data)

// Admin / merchant endpoints
export const getDashboard = () =>
  api.get<DashboardStats>('/admin/stats/dashboard').then((r) => r.data)

export const getTopProducts = () =>
  api.get<TopProductRow[]>('/admin/stats/top-products').then((r) => r.data)

export const getRecentBids = () =>
  api.get<Bid[]>('/admin/stats/recent-bids').then((r) => r.data)

export const getLiveAuctions = () =>
  api.get<Auction[]>('/admin/auctions/live').then((r) => r.data)

export const getAllAuctions = (status?: string) =>
  api.get<Auction[]>('/admin/auctions', { params: { status } }).then((r) => r.data)

export const getAllProducts = () =>
  api.get<Product[]>('/admin/products').then((r) => r.data)

// Buyer-side endpoints reused for merchant CRUD (creating products/auctions
// goes through the same routes — they're seller-authored anyway).
export const createProduct = (data: Partial<Product>) =>
  api.post<Product>('/products', data).then((r) => r.data)

export const updateProduct = (id: number, data: Partial<Product>) =>
  api.patch<Product>(`/products/${id}`, data).then((r) => r.data)

export const deleteProduct = (id: number) =>
  api.delete(`/products/${id}`).then(() => undefined)

export const createAuction = (data: {
  product_id: number
  start_price: number
  min_increment: number
  has_reserve: boolean
  reserve_price?: number
  has_buy_now: boolean
  buy_now_price?: number
  duration: number
}) => api.post<Auction>('/auctions', data).then((r) => r.data)

export const startAuction = (id: number) =>
  api.post<Auction>(`/auctions/${id}/start`).then((r) => r.data)

export const cancelAuction = (id: number, reason: string) =>
  api.post<Auction>(`/auctions/${id}/cancel`, { reason }).then((r) => r.data)

// Seller-side order endpoints
export const getSellerOrders = (status?: string) =>
  api.get<Order[]>('/admin/orders', { params: { status } }).then((r) => r.data)

export const shipOrder = (id: number, data: { tracking_no: string; ship_carrier?: string }) =>
  api.post<Order>(`/admin/orders/${id}/ship`, data).then((r) => r.data)

export default api
