import Taro from '@tarojs/taro'
import type { Auction, User } from '../types'

// Taro.request abstracts wx.request / fetch / etc. across platforms.
// We keep one tiny client here so call sites don't have to know about
// header injection or the API_BASE constant.
//
// Compared to the browser axios instance, the differences are:
//  - localStorage → Taro.getStorageSync
//  - window.location redirect → Taro.redirectTo
//  - error toast via Taro.showToast (cross-platform)
function request<T>(opts: { url: string; method?: keyof Taro.request.Method; data?: unknown }): Promise<T> {
  const token = Taro.getStorageSync('mp_token') as string | undefined
  return new Promise((resolve, reject) => {
    Taro.request({
      url: API_BASE + opts.url,
      method: (opts.method ?? 'GET') as keyof Taro.request.Method,
      data: opts.data,
      header: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
      success: (res) => {
        if (res.statusCode === 401) {
          Taro.removeStorageSync('mp_token')
          Taro.redirectTo({ url: '/pages/login/index' })
          reject(new Error('unauthorized'))
          return
        }
        if (res.statusCode >= 400) {
          const err = (res.data as { error?: string })?.error ?? '请求失败'
          Taro.showToast({ title: err, icon: 'none' })
          reject(new Error(err))
          return
        }
        resolve(res.data as T)
      },
      fail: (err) => {
        Taro.showToast({ title: '网络错误', icon: 'none' })
        reject(err)
      },
    })
  })
}

export const login = (data: { email: string; password: string }) =>
  request<{ token: string; user: User }>({ url: '/api/login', method: 'POST', data })

export const register = (data: { username: string; email: string; password: string }) =>
  request<{ token: string; user: User }>({ url: '/api/register', method: 'POST', data })

export const listAuctions = () =>
  request<Auction[]>({ url: '/api/auctions?status=active' })

export const getAuction = (id: number) =>
  request<{ auction: Auction; rankings: unknown[]; seconds_left: number }>({ url: `/api/auctions/${id}` })

export const placeBid = (auctionId: number, amount: number, clientBidId?: string) =>
  request<{ bid: unknown; current_price: number }>({
    url: `/api/auctions/${auctionId}/bids`,
    method: 'POST',
    data: { amount, client_bid_id: clientBidId },
  })
