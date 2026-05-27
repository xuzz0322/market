import axios from 'axios'
import type { AuthResponse, User, Product, Auction, Bid, BidRanking, Order, ShippingAddress, AuctionRoom } from '../types'

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

export interface ProductSearchResult extends Product {
  auction_id?: number   // current pending/active auction id, if any
}

export const searchProducts = (params: {
  q?: string
  category?: string
  page?: number
  limit?: number
}) =>
  api.get<{ products: ProductSearchResult[]; total: number; page: number; limit: number }>(
    '/products/search', { params }
  ).then((r) => r.data)

export const recommendedProducts = (limit = 12) =>
  api.get<ProductSearchResult[]>('/products/recommended', { params: { limit } }).then((r) => r.data)

// Auctions
export const createAuction = (data: {
  product_id: number
  start_price: number
  min_increment: number
  has_buy_now: boolean
  buy_now_price?: number
  requires_deposit?: boolean
  deposit_amount?: number
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

export const getAuctionRecommendations = (id: number, limit = 10) =>
  api.get<Auction[]>(`/auctions/${id}/recommendations`, { params: { limit } }).then((r) => r.data)

// Auction Rooms
export const createRoom = (data: { title: string; description?: string; cover_url?: string }) =>
  api.post<AuctionRoom>('/rooms', data).then((r) => r.data)

export const listRooms = (params?: { mine?: boolean; limit?: number }) =>
  api.get<AuctionRoom[]>('/rooms', { params }).then((r) => r.data)

export interface RoomDetailResponse {
  room: AuctionRoom
  current: (Auction & { seconds_left: number }) | null
  queue: Auction[]
  history: Auction[]
}

export const getRoom = (id: number) =>
  api.get<RoomDetailResponse>(`/rooms/${id}`).then((r) => r.data)

export const updateRoom = (id: number, data: Partial<{ title: string; description: string; cover_url: string }>) =>
  api.patch<AuctionRoom>(`/rooms/${id}`, data).then((r) => r.data)

export const closeRoom = (id: number) =>
  api.post<AuctionRoom>(`/rooms/${id}/close`).then((r) => r.data)

export const addRoomAuction = (
  roomId: number,
  data: {
    product_id: number
    start_price: number
    min_increment: number
    has_buy_now: boolean
    buy_now_price?: number
    duration: number
  },
) => api.post<{ auction: Auction; started: boolean }>(`/rooms/${roomId}/auctions`, data).then((r) => r.data)

export const startNextInRoom = (roomId: number) =>
  api.post<Auction>(`/rooms/${roomId}/start-next`).then((r) => r.data)

// Favorites
export const myFavorites = () =>
  api.get<Auction[]>('/me/favorites').then((r) => r.data)

export const myFavoriteIDs = () =>
  api.get<number[]>('/me/favorite-ids').then((r) => r.data)

export const favoriteAuction = (id: number) =>
  api.post<{ favorited: boolean }>(`/auctions/${id}/favorite`).then((r) => r.data)

export const unfavoriteAuction = (id: number) =>
  api.delete<{ favorited: boolean }>(`/auctions/${id}/favorite`).then((r) => r.data)

// Follows
export interface FollowedHost {
  id: number
  username: string
  avatar: string
  live: boolean
}

export const myFollows = () =>
  api.get<FollowedHost[]>('/me/follows').then((r) => r.data)

export const getFollowState = (hostId: number) =>
  api.get<{ following: boolean; follower_count: number }>(`/users/${hostId}/follow`).then((r) => r.data)

export const followUser = (hostId: number) =>
  api.post<{ following: boolean }>(`/users/${hostId}/follow`).then((r) => r.data)

export const unfollowUser = (hostId: number) =>
  api.delete<{ following: boolean }>(`/users/${hostId}/follow`).then((r) => r.data)

// Deposits — earnest payment for deposit-gated auctions.
export interface DepositState {
  required: boolean
  amount: number
  paid: boolean
  status?: 'held' | 'refunded' | 'applied'
}

export const getDepositState = (auctionId: number) =>
  api.get<DepositState>(`/auctions/${auctionId}/deposit`).then((r) => r.data)

export const payDeposit = (auctionId: number) =>
  api.post<{ paid: boolean; amount: number }>(`/auctions/${auctionId}/deposit`).then((r) => r.data)

export const withdrawDeposit = (auctionId: number) =>
  api.delete<{ refunded: boolean }>(`/auctions/${auctionId}/deposit`).then((r) => r.data)

export const myDeposits = () =>
  api.get<Array<{
    id: number
    auction_id: number
    auction?: Auction
    amount: number
    status: 'held' | 'refunded' | 'applied'
    created_at: string
    settled_at?: string
  }>>('/me/deposits').then((r) => r.data)

// Credit
export interface CreditEvent {
  id: number
  user_id: number
  delta: number
  after: number
  reason: string
  ref_type: string
  ref_id: number
  note: string
  created_at: string
}

export const myCredit = () =>
  api.get<{
    score: number
    min_to_bid: number
    max_score: number
    can_bid: boolean
    events: CreditEvent[]
  }>('/me/credit').then((r) => r.data)

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
