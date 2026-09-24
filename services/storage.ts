import { PodcastSession } from '../types';

// Keep the current episode and one pre-reset backup in IndexedDB. A transaction
// must commit before we issue another paid call or replace the current episode.
export async function sessionStore(action: 'read' | 'write' | 'reset' | 'previous', session?: PodcastSession): Promise<PodcastSession | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('gemini-podcast-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onerror = () => reject(new Error('เปิดที่เก็บเสียงในเบราว์เซอร์ไม่ได้'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('sessions', action === 'read' || action === 'previous' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('sessions');
      const operation = action === 'read' || action === 'previous' ? store.get(action === 'previous' ? 'previous' : 'current') : action === 'reset' ? store.get('current') : store.put(session, 'current');
      let result: PodcastSession | undefined;
      operation.onsuccess = () => {
        if (action === 'reset') {
          if (operation.result) store.put(operation.result, 'previous');
          store.put(session, 'current');
        }
        result = action === 'read' || action === 'previous' ? operation.result : session;
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error('บันทึกเสียงไม่ได้ พื้นที่เบราว์เซอร์อาจเต็ม — ดาวน์โหลดช่วงที่สำเร็จก่อนปิดหน้า')); };
    };
  });
}
