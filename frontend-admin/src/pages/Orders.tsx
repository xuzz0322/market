import { useEffect, useState } from 'react'
import {
  Card, Table, Tag, Button, Modal, Form, Input, Select, Tabs, message,
  Space, Descriptions, Empty,
} from 'antd'
import { ReloadOutlined, SendOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { getSellerOrders, shipOrder } from '../services/api'
import type { Order, OrderStatus, ShippingAddress } from '../types'

const statusMap: Record<OrderStatus, { color: string; label: string }> = {
  pending_address:  { color: 'orange',     label: '等买家填地址' },
  pending_shipment: { color: 'blue',       label: '待发货' },
  shipped:          { color: 'processing', label: '已发货' },
  completed:        { color: 'success',    label: '已完成' },
  cancelled:        { color: 'red',        label: '已取消' },
}

// Common Chinese carriers — admins type fewer characters this way.
const carriers = ['顺丰', '京东', '中通', '圆通', '韵达', '申通', '邮政', 'EMS', '其他']

function parseAddress(s?: string): ShippingAddress | null {
  if (!s) return null
  try { return JSON.parse(s) as ShippingAddress } catch { return null }
}

export default function OrdersPage() {
  const [list, setList] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('')

  // Ship modal state
  const [shipTarget, setShipTarget] = useState<Order | null>(null)
  const [shipForm] = Form.useForm()
  const [shipping, setShipping] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      setList(await getSellerOrders(statusFilter || undefined))
    } finally {
      setLoading(false)
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [statusFilter])

  const handleShip = async () => {
    if (!shipTarget) return
    const values = await shipForm.validateFields()
    setShipping(true)
    try {
      await shipOrder(shipTarget.id, values)
      message.success('已发货')
      setShipTarget(null)
      shipForm.resetFields()
      load()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      message.error(e.response?.data?.error ?? '发货失败')
    } finally {
      setShipping(false)
    }
  }

  return (
    <Card
      title={
        <Tabs
          items={[
            { key: '',                  label: '全部' },
            { key: 'pending_address',   label: '等买家填地址' },
            { key: 'pending_shipment',  label: '待发货' },
            { key: 'shipped',           label: '已发货' },
            { key: 'completed',         label: '已完成' },
          ]}
          activeKey={statusFilter}
          onChange={setStatusFilter}
          style={{ marginBottom: -16 }}
        />
      }
      extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>}
    >
      <Table
        dataSource={list}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
        expandable={{
          // Expand to show shipping address — saves a column for the
          // most common width-hogging field.
          expandedRowRender: (r) => {
            const addr = parseAddress(r.shipping_address)
            return (
              <Descriptions size="small" column={2} bordered styles={{ label: { width: 110 } }}>
                <Descriptions.Item label="订单号">{r.order_no}</Descriptions.Item>
                <Descriptions.Item label="拍卖 ID">#{r.auction_id}</Descriptions.Item>
                <Descriptions.Item label="买家">{r.buyer?.username ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="联系电话">{addr?.phone ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="收货人">{addr?.name ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="地区">
                  {addr ? `${addr.province ?? ''} ${addr.city ?? ''} ${addr.district ?? ''}`.trim() || '—' : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="详细地址" span={2}>
                  {addr?.detail ?? <span style={{ color: '#bbb' }}>买家尚未填写</span>}
                </Descriptions.Item>
                {r.tracking_no && (
                  <Descriptions.Item label="物流" span={2}>
                    {r.ship_carrier} · {r.tracking_no}
                  </Descriptions.Item>
                )}
                {r.cancel_reason && (
                  <Descriptions.Item label="取消原因" span={2}>{r.cancel_reason}</Descriptions.Item>
                )}
              </Descriptions>
            )
          },
        }}
        columns={[
          { title: '订单号', dataIndex: 'order_no', width: 200, ellipsis: true },
          { title: '商品', dataIndex: ['product', 'title'], ellipsis: true },
          { title: '买家', dataIndex: ['buyer', 'username'], width: 120 },
          {
            title: '成交价', dataIndex: 'amount', width: 110, align: 'right',
            render: (v: number) => <strong style={{ color: '#cf1322' }}>¥{v.toLocaleString()}</strong>,
          },
          {
            title: '状态', dataIndex: 'status', width: 130, align: 'center',
            render: (s: OrderStatus) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.label ?? s}</Tag>,
          },
          {
            title: '下单时间', dataIndex: 'created_at', width: 160,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
          },
          {
            title: '操作', width: 120, align: 'center',
            render: (_v, r: Order) => {
              if (r.status === 'pending_shipment') {
                return (
                  <Button type="link" size="small" icon={<SendOutlined />} onClick={() => setShipTarget(r)}>
                    发货
                  </Button>
                )
              }
              if (r.status === 'shipped') {
                return <span style={{ color: '#999', fontSize: 12 }}>等待买家收货</span>
              }
              if (r.status === 'pending_address') {
                return <span style={{ color: '#999', fontSize: 12 }}>等买家填地址</span>
              }
              return <span style={{ color: '#999', fontSize: 12 }}>—</span>
            },
          },
        ]}
        locale={{ emptyText: <Empty description="暂无订单" /> }}
      />

      <Modal
        title="发货"
        open={!!shipTarget}
        onCancel={() => { setShipTarget(null); shipForm.resetFields() }}
        onOk={handleShip}
        confirmLoading={shipping}
        okText="确认发货"
        width={500}
      >
        {shipTarget && (
          <>
            <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="订单号">{shipTarget.order_no}</Descriptions.Item>
              <Descriptions.Item label="商品">{shipTarget.product?.title}</Descriptions.Item>
              <Descriptions.Item label="收件人">
                {(() => {
                  const a = parseAddress(shipTarget.shipping_address)
                  return a ? `${a.name} · ${a.phone}` : '—'
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="地址">
                {(() => {
                  const a = parseAddress(shipTarget.shipping_address)
                  return a ? `${a.province ?? ''} ${a.city ?? ''} ${a.district ?? ''} ${a.detail}` : '—'
                })()}
              </Descriptions.Item>
            </Descriptions>
            <Form form={shipForm} layout="vertical">
              <Form.Item name="ship_carrier" label="物流公司">
                <Select options={carriers.map((c) => ({ label: c, value: c }))} placeholder="选择物流公司" allowClear />
              </Form.Item>
              <Form.Item name="tracking_no" label="快递单号" rules={[{ required: true, message: '请输入快递单号' }]}>
                <Input placeholder="例：SF1234567890" maxLength={64} />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>
    </Card>
  )
}
