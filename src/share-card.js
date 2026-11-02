function text(value, limit = 240) {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit) : '';
}

function link(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

export function shareCardInfo(type, data = {}) {
  let item;
  if (type === 'music') {
    const id = String(data.id || '');
    const url = data.url || (data.type === '163' && /^\d+$/.test(id) ? `https://music.163.com/song?id=${id}` : '');
    item = { title: data.title, desc: data.content, tag: data.type === '163' ? '网易云音乐' : '音乐', jumpUrl: url, preview: data.image };
  } else {
    let card = data.data;
    try {
      if (typeof card === 'string') {
        if (card.length > 100000) return { error: '[卡片消息：内容过大，未解析]' };
        card = JSON.parse(card);
      }
    } catch { return { error: '[卡片消息：格式无法解析]' }; }
    if (!card || typeof card !== 'object') return {};
    const meta = card.meta;
    item = meta?.news || meta?.music || meta?.detail_1 || meta?.detail;
    if (!item || typeof item !== 'object') return {};
  }
  const info = {
    source: text(item.tag || item.appname || item.appName, 60),
    title: text(item.title, 500),
    description: text(item.desc || item.content || item.summary, 1500),
    author: text(item.author || item.artist || item.singer || item.uploader, 120),
    url: link(item.jumpUrl || item.qqdocurl || item.url),
    cover: link(item.preview || item.cover || item.image || item.pic),
    audio: link(item.musicUrl || item.audio),
    video: link(item.videoUrl),
    duration: text(String(item.duration ?? ''), 40)
  };
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value));
}

export function shareCardText(type, data = {}) {
  const info = shareCardInfo(type, data);
  if (info.error) return info.error;
  const labels = { source: '来源', title: '标题', description: '描述', author: '作者', url: '链接', audio: '音频链接', video: '视频链接', duration: '时长' };
  const fields = Object.entries(info).filter(([key]) => key !== 'cover').map(([key, value]) => `${labels[key]}：${value}`);
  if (info.cover) fields.push('封面：[图片]（可用 get_message_images 查看）');
  return fields.length ? `[分享卡片（仅摘要，未读取音视频）：${fields.join('；')}]` : '[卡片消息]';
}
