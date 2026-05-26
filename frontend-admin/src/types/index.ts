export type UserRole = 'user' | 'seller' | 'admin'
export type AuctionStatus = 'pending' | 'active' | 'ended' | 'cancelled'

export interface User {
  id: number
  username: string
  email: string
  avatar: string
  balance: number
  role: UserRole
  created_at: string
}

export interface Product {
  id: number
  seller_id: number
  seller?: User
  title: string
  description: string
  images: string
  video_url: string
  category: string
  status: 'draft' | 'active' | 'auctioning' | 'sold' | 'ended'
  created_at: string
}

export interface Auction {
  id: number
  product_id: number
  product?: Product
  seller_id: number
  seller?: User
  start_price: number
  current_price: number
  min_increment: number
  has_reserve: boolean
  reserve_price: number
  has_buy_now: boolean
  buy_now_price: number
  duration: number
  start_time?: string
  end_time?: string
  status: AuctionStatus
  winner_id?: number
  winner?: User
  bid_count: number
  view_count: number
  cancel_reason?: string
  cancelled_at?: string
  seconds_left?: number
  created_at: string
}

export type OrderStatus =
  | 'pending_address' | 'pending_shipment' | 'shipped' | 'completed' | 'cancelled'

export interface ShippingAddress {
  name: string
  phone: string
  province?: string
  city?: string
  district?: string
  detail: string
  zip_code?: string
}

export interface Order {
  id: number
  order_no: string
  auction_id: number
  auction?: Auction
  product_id: number
  product?: Product
  seller_id: number
  seller?: User
  buyer_id: number
  buyer?: User
  amount: number
  status: OrderStatus
  shipping_address: string  // JSON-encoded ShippingAddress
  tracking_no: string
  ship_carrier: string
  paid_at?: string
  shipped_at?: string
  completed_at?: string
  cancel_reason?: string
  created_at: string
}

export interface Bid {
  id: number
  auction_id: number
  auction?: Auction
  user_id: number
  user?: User
  amount: number
  status: 'active' | 'outbid' | 'won' | 'cancelled'
  created_at: string
}

export interface DashboardStats {
  active_auctions: number
  today_bids: number
  today_gmv: number
  total_products: number
  today_views: number
  live_bidders: number
}

export interface TopProductRow {
  auction_id: number
  product_title: string
  current_price: number
  bid_count: number
  view_count: number
  status: AuctionStatus
}
