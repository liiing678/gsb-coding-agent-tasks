// SSE 帧的编码：已实现，别改。
//
//   formatFrame({ id: '3', event: 'order.created', data: { id: 7 } })
//   -> 'id: 3\nevent: order.created\ndata: {"id":7}\n\n'
export function formatFrame({ id, event, data }) {
  const lines = [`id: ${id}`, `event: ${event}`];
  if (data !== undefined) {
    lines.push(`data: ${JSON.stringify(data)}`);
  }
  return `${lines.join('\n')}\n\n`;
}
