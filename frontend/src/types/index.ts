export interface User {
  id: number
  username: string
  email: string
  avatar: string
  balance: number
  credit_score: number
  created_at: string
}

export interface Product {
  id: number
  seller_id: number
  seller?: User
  title: string
  description: string
  images: string   // JSON array string
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
  room_id?: number
  start_price: number
  current_price: number
  min_increment: number
  has_reserve: boolean
  reserve_price: number
  has_buy_now: boolean
  buy_now_price: number
  requires_deposit: boolean
  deposit_amount: number
  duration: number
  start_time?: string
  end_time?: string
  status: 'pending' | 'active' | 'ended' | 'cancelled'
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
  shipping_address: string
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
  user_id: number
  user?: User
  amount: number
  status: 'active' | 'outbid' | 'won' | 'cancelled'
  created_at: string
}

export interface BidRanking {
  rank: number
  user_id: number
  username: string
  avatar: string
  amount: number
}

// WebSocket message types
export type WSMessageType =
  | 'join_auction'
  | 'leave_auction'
  | 'place_bid'
  | 'bid_update'
  | 'bid_outbid'
  | 'auction_end'
  | 'auction_start'
  | 'auction_cancel'
  | 'countdown'
  | 'error'
  | 'view_update'
  | 'join_room'
  | 'leave_room'
  | 'stream_start'
  | 'stream_stop'
  | 'webrtc_signal'
  | 'heat_update'
  | 'chat_send'
  | 'chat_message'
  | 'host_live'
  | 'auction_starting'
  | 'dm_received'

export interface WSMessage<T = unknown> {
  type: WSMessageType
  auction_id?: number
  room_id?: number
  data?: T
}

export interface BidUpdateData {
  auction_id: number
  current_price: number
  bid_count: number
  last_bidder: string
  rankings: BidRanking[]
  viewer_count: number
  seconds_left: number
  end_at_ms: number       // absolute end timestamp (server ms)
  server_time_ms: number  // server "now" at broadcast time
  seq: number             // per-auction monotonic sequence
}

export interface BidOutbidData {
  auction_id: number
  product_title: string
  your_bid: number
  current_price: number
  new_leader: string
  seconds_left: number
}

export interface AuctionEndData {
  auction_id: number
  winner_id?: number
  winner_name: string
  final_price: number
}

export interface AuctionCancelData {
  auction_id: number
  reason: string
}

export interface AuthResponse {
  token: string
  user: User
}

export interface AuctionRoom {
  id: number
  host_id: number
  host?: User
  title: string
  description: string
  cover_url: string
  status: 'open' | 'closed'
  current_auction_id?: number
  is_streaming: boolean
  heat_score: number
  total_auctions: number
  created_at: string
  updated_at: string
}

export interface WebRTCSignalData {
  from: number
  to: number
  signal_type: 'offer' | 'answer' | 'ice' | 'request' | 'bye'
  payload: unknown
  room_id: number
}

export interface StreamStateData {
  room_id: number
  host_id: number
  streaming: boolean
}

export interface ChatMessageData {
  room_id: number
  user_id: number
  username: string
  avatar: string
  text: string
  is_host: boolean
  timestamp: number
}

export interface HostLiveData {
  host_id: number
  username: string
  room_id: number
  room_title: string
}

export interface AuctionStartingData {
  host_id: number
  username: string
  auction_id: number
  product_title: string
  room_id?: number
}
