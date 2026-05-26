export type AuctionStatus = 'pending' | 'active' | 'ended' | 'cancelled'

export interface User {
  id: number
  username: string
  email: string
  avatar: string
  balance: number
  role: 'user' | 'seller' | 'admin'
}

export interface Product {
  id: number
  title: string
  description: string
  images: string
  category: string
}

export interface Auction {
  id: number
  product_id: number
  product?: Product
  current_price: number
  start_price: number
  min_increment: number
  has_buy_now: boolean
  buy_now_price: number
  duration: number
  status: AuctionStatus
  bid_count: number
  view_count: number
  end_time?: string
  seconds_left?: number
}
