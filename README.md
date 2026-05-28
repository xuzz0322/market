# 拍卖直播系统

一个以**竞价直播**为核心的实时拍卖平台，具备 TikTok 风格的移动端刷拍体验、主播开间排队拍卖、WebRTC 实时讲解、Kafka 异步任务、Redis 多维热度算法等生产级特性。

---

## 系统架构

```
┌──────────────────────────────────────────────────────────┐
│  frontend/  (用户端 H5 · React + TS + Tailwind · :5173)  │
│  • TikTok 竖向刷拍  • 推荐 / 关注间 双 Tab               │
│  • 实时出价动画     • WebRTC 主播讲解  • 私信             │
└─────────────────────────┬────────────────────────────────┘
                          │ REST + WebSocket
┌─────────────────────────▼────────────────────────────────┐
│          Backend  Go 1.21 + Gin · :8080                  │
│  /api/*   普通用户端        /api/admin/*  商家/管理       │
│  /ws      WebSocket 实时通道 (JWT 鉴权)                   │
└──────┬─────────────┬────────────┬───────────────┬────────┘
       │             │            │               │
  ┌────▼────┐  ┌─────▼────┐  ┌───▼───┐  ┌────────▼──────┐
  │  MySQL  │  │  Redis   │  │ Kafka │  │  WebRTC STUN  │
  │ 权威数据 │  │ 缓存/Pub/Sub│ │ 异步任务│  │  (Google)     │
  └─────────┘  └──────────┘  └───────┘  └───────────────┘
```

---

## 🌟 亮点功能与技术实现

### 1. 高并发出价——三重并发安全保证

**文件**: `backend/handlers/bid.go`

```
客户端 → POST /api/auctions/:id/bids
           │
           ├─ 幂等快路: client_bid_id 唯一索引，重复请求秒返回先前结果
           │
           └─ 事务路径:
               SELECT ... FOR UPDATE  (行锁，串行化并发出价)
               校验 status / 到期时间 / 信用分 / 余额 / 保证金
               UPDATE WHERE version = ?  (乐观锁版本号兜底)
               INSERT bid
               → 最多重试 3 次 (死锁1213 / 锁等待超时1205 / 版本冲突)
               → Kafka produce: NotifyOutbid / HeatIncr
```

- **行级 SELECT FOR UPDATE**：拍卖行 + 用户余额行分别锁定，防止并发双扣
- **乐观锁版本号**：`UPDATE WHERE version = ?` 多 Pod 部署下的第二道防线
- **幂等性**：`(auction_id, client_bid_id)` DB 唯一索引，客户端重试不产生重复出价
- **退避重试**：每次 `20ms × attempt` 累加抖动，3 次上限

---

### 2. Redis 多维热度算法——实时拍卖间排行

**文件**: `backend/cache/heat.go`

```
heat = 实时观看人数 × 8        ← WS room size（最强信号）
     + 近1h出价次数  × 5        ← Redis delta counter（出价即加）
     + 近1h新增收藏  × 3        ← Redis delta counter（收藏即加）
     + log(历史出价量+1) × 2    ← 长尾积累，log 防止垄断
     + 新开拍2h内线性衰减 +20   ← 新间发现促进
```

- 每 **30s** 扫描一次，Pipeline 批量读 Redis delta 计数器后立即 DEL 重置窗口
- 结果写入 Redis ZSET `room:heat`（5min TTL 自愈）+ 回写 MySQL `heat_score`
- 扫描完成后通过 WS `heat_update` 广播 Top-10 排名到所有在线客户端，前端实时重排 Feed 无需轮询
- **MySQL 冷启动降级**：Redis 不可用时，`/rooms/hot` 直接走 `ORDER BY heat_score DESC`

---

### 3. Redis 排行榜——ZADD GT 保证单调性

**文件**: `backend/cache/rankings.go`

```go
// ZADD auction:rankings:{id} GT 出价金额 user_id
// GT 标志：只有更高出价才能替换，旧出价绝不覆盖新的
rdb.ZAddArgs(ctx, AuctionRankings(auctionID), redis.ZAddArgs{GT: true, Members: ...})
```

- 乱序到达的 WS 消息（tab 唤醒/网络抖动）不会回退排行榜
- Pipeline 批量读 `user:cache:{id}` HASH 获取 username/avatar，**单次 RTT** 返回带用户名的 Top-N 排名
- 冷启动自愈：Redis 未命中时从 MySQL `GROUP BY user_id` 重建，写回 Redis 后续读走缓存

---

### 4. Redis Circuit Breaker——故障隔离

**文件**: `backend/cache/redis.go`

```
连续 5 次失败 → 熔断 30s（atomic bool + atomic int64 时间戳）
熔断期间:
  Available() = false → 所有调用立即返回 ErrCacheUnavailable
  调用方自动降级到 MySQL 路径
30s 后放行一个探针请求，成功则重置计数器
```

- `Available()` 是 **原子加载**，热路径调用无锁开销
- 熔断不是 goroutine 驱动，无额外内存分配

---

### 5. Redis Pub/Sub 多 Pod 广播桥

**文件**: `backend/cache/pubsub.go`

- 每个 Pod 的 WS Hub 都订阅同一个 `ws:broadcast` 频道
- 广播时先本地派发（同 Pod 延迟 < 1ms），再 Pub/Sub 通知其他 Pod
- **回声防重**：Envelope 携带 `instance_id`，订阅者跳过自己发出的消息
- 选 Pub/Sub 而非 Streams 的理由：拍卖出价消息不需要重放，Pub/Sub 比 Streams 快 ~5×；客户端 seq 跳号检测 + HTTP 重同步兜底

---

### 6. WebSocket Hub——万人拍卖室设计

**文件**: `backend/ws/hub.go`

| 数据结构 | 用途 |
|---------|------|
| `clients map[*Client]bool` | 全局连接池 |
| `rooms map[uint]map[*Client]bool` | 按 auction_id 分组的出价室 |
| `auctionRoomMembers map[uint]map[*Client]bool` | 主播间（Room）频道 |
| `userClients map[uint]map[*Client]bool` | 用户→多连接索引（手机+电脑同时在线） |

- **快照后派发**：广播时 RLock 快照接收者列表，锁外执行 channel send；慢客户端不阻塞其他人
- **背压路由**：channel 满时 drop-oldest + 重试；连续 drop 100 次则 WritePump 主动断开（zombie 连接清除）
- **每拍卖单调序号**：`seq` 字段让客户端检测 WS 丢包，跳号 → 立即 HTTP 重同步
- `PushToUser` 精准推送"你被超越"通知，即使用户不在该拍卖间也能收到

---

### 7. WS 客户端——时钟偏差修正的倒计时

**文件**: `frontend/src/services/websocket.ts` / `frontend/src/components/CountdownTimer.tsx`

- 每条 `bid_update` 携带 `server_time_ms`，客户端计算 `clockSkew = serverNow - localNow`
- 倒计时用 `endAtMs - (Date.now() + clockSkew)` 计算，而非本地递减整数
- 结果：即使用户设备时间错误 ±5 分钟，倒计时与服务端同步

---

### 8. 拍卖结算——原子 CAS 防双结算

**文件**: `backend/services/auction.go`

```go
// 只有一个 Pod 能把 active → ended
claim := db.Where("id = ? AND status = ?", id, AuctionActive).Update("status", AuctionEnded)
if claim.RowsAffected == 0 {
    return  // 其他 Pod 已结算，直接退出
}
// 唯一进入这里的 Pod 负责：找中标人、扣余额、创建订单、广播结果
```

- 无分布式锁，依赖 MySQL 单行原子 UPDATE；多 Pod 并发时只有一个会成功

---

### 9. Kafka 异步解耦——三级语义选型

**文件**: `backend/mq/`

| Topic | 触发方 | 语义 | 理由 |
|-------|--------|------|------|
| `notify.outbid` | 出价成功后 | at-most-once | 丢一条 toast 不是资金损失 |
| `credit.adjust` | 订单确认/取消 | at-least-once | 信用分调整可幂等重试 |
| `heat.incr` | 出价/收藏 | at-most-once | 热度是统计指标，允许误差 |
| `dm.send` | 私信发送后 | at-least-once | 重复 WS push 客户端按 msg_id 去重 |

- **Kafka 不可用降级**：`KAFKA_BROKERS` 未配置时 `Producer.Available()=false`，所有路径退回同步执行，服务零感知
- 出价超越通知从 `go goroutine` 迁移到 Kafka，每个被替代用户独立 partition key，保证该用户的通知有序

---

### 10. WebRTC P2P 主播讲解——无媒体服务器

**文件**: `frontend/src/hooks/useLiveStream.ts`

```
主播                    服务端信令             观众
  │                        │                    │
  │── stream_start ────────►│── broadcast ──────►│
  │                        │◄── request ─────────│
  │◄───────────────────────│── (forward) ────────│
  │── offer ───────────────►│──────────────────►│
  │◄── answer ─────────────│◄─────────────────── │
  │── ICE candidates ───────►│──────────────────►│
  │◄── ICE candidates ──────│◄─────────────────── │
  │════════ P2P 视频流 ════════════════════════════│
```

- 信令通过已有 WS 通道传输，无需额外服务器
- 主播 → 每个观众独立 `RTCPeerConnection`，host-fanout 拓扑
- 服务端强制覆盖 `from` 字段防止伪造身份
- 视频约束：640×480 / 24fps / 回声消除 + 降噪（适合讲解流量预算）

---

### 11. 保证金担保系统——三状态生命周期

**文件**: `backend/models/deposit.go` / `backend/handlers/deposit.go`

```
paid ──► held ──┬──► applied  (中标：抵扣最终成交价)
                └──► refunded (流拍/未中标/卖家取消：全额退回)
```

- 出价前检查 `DepositHeld` 状态，未缴纳直接 402 拒绝
- 中标时从余额只扣 `成交价 - 保证金`，保证金 `held → applied`
- 取消时触发 `refundAllHeldDeposits`，每笔退款包在独立事务：余额 UPDATE + 状态 UPDATE 同生共死

---

### 12. 信用分系统——审计日志原子一致

**文件**: `backend/services/credit.go`

- `SELECT FOR UPDATE → UPDATE → INSERT CreditEvent` 同一事务，保证 `CreditEvent.After` 字段精确记录本次调整后的分数
- 分数 clamp 在 `[0, CreditMaxScore=150]`，两次相同调整结果相同（幂等）
- **Kafka 异步消费**：从主事务解耦，提交速度不受信用分写入影响；消费失败可重试，最终一致

---

### 13. TikTok 风格首页——双 Tab 架构

**文件**: `frontend/src/components/AuctionFeed.tsx`

- **推荐 Tab**：竖向全屏翻页，鼠标滚轮 / 触摸滑动 / 键盘方向键三端兼容；出价动画（金额放大→还原 + 粉色粒子飞出）
- **关注间 Tab**：调用 `/me/followed-rooms`，2 列卡片网格，LIVE 红点；空状态引导关注主播
- 监听 `heat_update` WS 消息实时重排，`motion.div layout` 动画平滑过渡，不触发 HTTP 请求

---

### 14. 全局被超越通知——跨页面推送

**文件**: `frontend/src/hooks/useOutbidNotifier.tsx`

- 挂载在 App 根节点，不依赖当前页面
- 检查 `window.__auctionFocus`：**正在查看该拍卖** → 静默（detail 页有内联横幅）；**在其他页面** → toast + 浏览器 Notification
- Notification API 在用户登录后异步请求权限，不打断首次打开体验

---

### 15. 私信系统——Kafka + WS 实时推送

**文件**: `backend/handlers/dm.go` / `frontend/src/pages/DMThread.tsx`

- 消息先写 MySQL（持久化），再 Kafka produce（获得 msg_id 后）
- 消费者加载发件人姓名，`PushToUser` 到接收者所有在线连接
- 前端游标翻页（`?before=<msg_id>`），Enter 发送，textarea 自增高
- 被拉黑用户无法发送私信（发送端校验 `Block` 表）

---

## 启动方式

### Docker Compose（推荐）

```bash
# 启动 MySQL + Redis + Kafka + 后端 + 前端
docker-compose up -d
```

> Kafka 使用 KRaft 模式（无 ZooKeeper），单 broker 开箱即用。

### 本地开发

```bash
# 后端（需要 KAFKA_BROKERS 环境变量；不配置则 Kafka 功能自动降级）
cd backend
export $(cat .env | xargs)
GOPROXY=https://goproxy.cn,direct go run .

# 用户端 H5  →  http://localhost:5173
cd frontend && npm install && npm run dev
```

---

## API 概览

### 核心用户端

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/register` | 注册（role: user/seller） |
| POST | `/api/login` | 登录，返回 JWT |
| GET | `/api/auctions` | 拍卖列表（自动过滤已拉黑卖家） |
| POST | `/api/auctions/:id/bids` | 出价（行锁 + 乐观锁 + 幂等） |
| GET | `/api/auctions/:id/deposit` | 查询保证金状态 |
| POST | `/api/auctions/:id/deposit` | 缴纳保证金 |
| GET | `/api/rooms/hot` | 热度排行拍卖间（Redis ZSET → MySQL 降级） |
| GET | `/api/me/followed-rooms` | 关注的主播拍卖间 |
| GET | `/api/me/credit` | 信用分 + 变更记录 |
| GET | `/api/me/messages` | 私信会话列表 |
| POST | `/api/users/:id/messages` | 发送私信 |
| POST | `/api/users/:id/block` | 拉黑用户 |

### WebSocket 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `bid_update` | Server→Client | 出价更新（seq + server_time + end_at_ms） |
| `bid_outbid` | Server→User | 个人超越通知 |
| `auction_end` | Server→Room | 拍卖结束 |
| `heat_update` | Server→All | 热度排行变化（30s 周期） |
| `stream_start/stop` | Server→Room | 主播开始/停止讲解 |
| `webrtc_signal` | Server→User | P2P 信令路由 |
| `dm_received` | Server→User | 新私信到达 |

### 商家/管理后台

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/stats/dashboard` | 数据看板 |
| GET | `/api/admin/auctions/live` | 正在直播的拍卖 |
| GET | `/api/admin/orders` | 卖家订单管理 |
| POST | `/api/admin/orders/:id/ship` | 标记发货 |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端框架 | Go 1.21 + Gin + GORM |
| 实时通信 | gorilla/websocket + 自研 Hub |
| 缓存/排行 | Redis 7（ZSET / Pub/Sub / INCR） |
| 消息队列 | Kafka 3.6 KRaft（IBM/sarama） |
| 数据库 | MySQL 8.0 |
| 前端框架 | React 18 + TypeScript + Tailwind CSS |
| 动画 | Framer Motion |
| 实时音视频 | WebRTC P2P（无媒体服务器） |
| 容器化 | Docker Compose |
