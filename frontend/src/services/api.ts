import axios from 'axios'
import type { AuthResponse, User, Product, Auction, Bid, BidRanking, Order, ShippingAddress } from '../types'

const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

// Auth
export const register = (data: { username: string; email: string; password: string }) =>
  api.post<AuthResponse>('/register', data).then((r) => r.data)

export const login = (data: { email: string; password: string }) =>
  api.post<AuthResponse>('/login', data).then((r) => r.data)

export const getMe = () => api.get<User>('/me').then((r) => r.data)

// Products
export const createProduct = (data: Partial<Product>) =>
  api.post<Product>('/products', data).then((r) => r.data)

export const listProducts = (params?: { category?: string; mine?: boolean; status?: string }) =>
  api.get<Product[]>('/products', { params }).then((r) => r.data)

export const getProduct = (id: number) =>
  api.get<Product>(`/products/${id}`).then((r) => r.data)

// Auctions
export const createAuction = (data: {
  product_id: number
  start_price: number
  min_increment: number
  has_buy_now: boolean
  buy_now_price?: number
  duration: number
}) => api.post<Auction>('/auctions', data).then((r) => r.data)

export const listAuctions = (params?: { status?: string }) =>
  api.get<Auction[]>('/auctions', { params }).then((r) => r.data)

export const getAuction = (id: number) =>
  api.get<{ auction: Auction; rankings: BidRanking[]; seconds_left: number; user_bid: number }>(
    `/auctions/${id}`
  ).then((r) => r.data)

export const startAuction = (id: number) =>
  api.post<Auction>(`/auctions/${id}/start`).then((r) => r.data)

export const cancelAuction = (id: number, reason: string) =>
  api.post<Auction>(`/auctions/${id}/cancel`, { reason }).then((r) => r.data)

// Bids
export const placeBid = (auctionId: number, amount: number) =>
  api.post<{ bid: Bid; current_price: number; rankings: BidRanking[] }>(
    `/auctions/${auctionId}/bids`,
    { amount }
  ).then((r) => r.data)

export const getBids = (auctionId: number) =>
  api.get<Bid[]>(`/auctions/${auctionId}/bids`).then((r) => r.data)

// Orders (buyer side)
export const getMyOrders = (status?: string) =>
  api.get<Order[]>('/orders', { params: { status } }).then((r) => r.data)

export const setOrderAddress = (id: number, address: ShippingAddress) =>
  api.post<Order>(`/orders/${id}/address`, { address }).then((r) => r.data)

export const confirmOrder = (id: number) =>
  api.post<Order>(`/orders/${id}/confirm`).then((r) => r.data)

export default api
