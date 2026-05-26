# 拍卖直播系统

三端架构：

```
┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐
│  frontend (用户端 H5)  │  │  frontend-admin       │  │  frontend-miniapp     │
│  React + TS + Tailwind │  │  React + TS + Antd    │  │  Taro + React (微信   │
│  TikTok 风格竖向滑动   │  │  PC 后台 (Antd)       │  │  小程序 / H5 多端)    │
│  :5173                 │  │  :5174                │  │  :10086 (h5)          │
└───────────┬───────────┘  └───────────┬───────────┘  └───────────┬───────────┘
            │                          │                          │
            └──────────────────────────┼──────────────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │   Backend (Go + Gin) :8080                  │
                │   REST /api/* + WebSocket /ws               │
                │   • /api/...     用户端通用                  │
                │   • /api/admin/* 商家/管理端 (RequireRole)   │
                └─────────────┬───────────────────┬───────────┘
                              │                   │
                       ┌──────▼──────┐     ┌──────▼──────┐
                       │   MySQL     │     │   Redis     │
                       │  权威数据   │     │ 热点缓存     │
                       │             │     │ + Pub/Sub   │
                       └─────────────┘     └─────────────┘
```

## 三端职责

| 工程 | 端 | 用户角色 | 主要场景 |
|------|------|---------|---------|
| `frontend/`            | 移动端 H5    | 普通用户     | TikTok 风格刷拍、出价、查看排行 |
| `frontend-admin/`      | PC 浏览器    | 商家 / 管理员 | 商品上架、配置拍卖、Dashboard、直播控制台 |
| `frontend-miniapp/`    | 微信小程序 + H5 | 普通用户  | 移动端补全（小程序生态接入） |

## 用户角色 (`User.role`)

| Role | 注册方式 | 可访问 |
|------|---------|--------|
| `user`   | 公开注册（默认） | 用户端浏览/出价 |
| `seller` | 公开注册（"商家入驻"） | 商家后台 + 用户端 |
| `admin`  | DB 直接创建 | 全部 + 跨商家数据 |

后端中间件 `middleware.RequireRole(...)` 在 `/api/admin/*` 路由组上严格校验。

## 启动方式

### Docker Compose（一键启动后端 + 数据库）

```bash
docker-compose up -d   # MySQL + Redis + Backend
```

### 本地开发

```bash
# 后端
cd backend && export $(cat .env | xargs)
GOPROXY=https://goproxy.cn,direct go run .

# 用户端 H5  →  http://localhost:5173
cd frontend && npm install && npm run dev

# 商家后台   →  http://localhost:5174
cd frontend-admin && npm install && npm run dev

# 小程序 H5  →  http://localhost:10086
# 小程序原生 →  npm run dev:weapp 后用微信开发者工具打开 dist/
cd frontend-miniapp && npm install
npm run dev:h5      # 浏览器调试
npm run dev:weapp   # 编译微信小程序产物到 dist/
```

## 后端 API 概览

### 公共接口
- `POST /api/register`           注册（role 可选: user/seller）
- `POST /api/login`              登录
- `GET  /api/me`                 当前用户
- `GET  /api/auctions`           拍卖列表
- `GET  /api/auctions/:id`       拍卖详情 + 排名
- `POST /api/auctions/:id/bids`  出价（行锁 + 幂等）
- `POST /api/auctions/:id/cancel` 异常取消（卖家本人）

### WebSocket
- `GET /ws?token=...`            实时通道
  - `bid_update` 出价更新（含 seq + server_time + end_at_ms）
  - `auction_end` 拍卖结束
  - `auction_cancel` 取消通知
  - `countdown` 倒计时心跳

### 商家/管理后台 (RequireRole: seller, admin)
- `GET /api/admin/stats/dashboard`   Dashboard 数据卡片
- `GET /api/admin/stats/top-products` 业绩排行
- `GET /api/admin/stats/recent-bids`  最近出价流
- `GET /api/admin/auctions/live`      正在直播的拍卖
- `GET /api/admin/auctions`           全部拍卖（含 ended/cancelled）
- `GET /api/admin/products`           全部商品（含 draft）
# market
