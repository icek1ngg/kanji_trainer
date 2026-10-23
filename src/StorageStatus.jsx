import { useEffect, useState } from 'react';
import { openDatabase } from './data/database.js';

// Opening storage never prevents navigation or resets existing data on failure.
export default function StorageStatus() {
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let disposed = false;
    let connection;
    const notify = text => { if (!disposed) setMessage(text); };
    setMessage('');
    openDatabase({
      onBlocked: () => notify('Cơ sở dữ liệu đang chờ cập nhật. Hãy đóng các thẻ Kanji Trainer khác rồi thử lại.'),
      onBlocking: () => notify('Cơ sở dữ liệu đang được cập nhật ở thẻ khác. Hãy tải lại trang sau khi cập nhật hoàn tất.'),
      onTerminated: () => notify('Kết nối dữ liệu đã bị gián đoạn. Hãy thử kết nối lại.'),
    }).then(db => {
      if (disposed) db.close();
      else { connection = db; setMessage(''); }
    }).catch(() => notify('Không thể mở dữ liệu trên thiết bị. Hãy kiểm tra quyền lưu trữ của trình duyệt rồi thử lại.'));
    return () => { disposed = true; connection?.close(); };
  }, [retry]);

  return message ? <div className="storage-notice" role="alert"><p>{message}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}>Thử kết nối lại</button></div> : null;
}
