let stream = null;
let timer = null;
let detector = null;

const deviceId = localStorage.getItem('simwalasDeviceId') || makeDeviceId();
localStorage.setItem('simwalasDeviceId', deviceId);

window.addEventListener('load', () => {
  document.getElementById('gasUrl').value = localStorage.getItem('gasUrl') || '';
  document.getElementById('scanToken').value = localStorage.getItem('scanToken') || '';
});

function makeDeviceId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return String(Date.now()) + Math.random().toString(16).slice(2);
}

function saveConfig() {
  localStorage.setItem('gasUrl', value('gasUrl'));
  localStorage.setItem('scanToken', value('scanToken'));
  showResult('success', 'Konfigurasi tersimpan', 'URL Apps Script dan token scanner disimpan di browser ini.');
}

function jsonp(params) {
  return new Promise((resolve, reject) => {
    const gasUrl = value('gasUrl');
    if (!gasUrl) {
      reject(new Error('Apps Script Web App URL belum diisi.'));
      return;
    }

    const callback = 'simwalas_cb_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    const script = document.createElement('script');

    window[callback] = response => {
      delete window[callback];
      script.remove();
      resolve(response);
    };

    const query = new URLSearchParams({
      ...params,
      callback
    });

    script.src = gasUrl + '?' + query.toString();
    script.onerror = () => {
      delete window[callback];
      script.remove();
      reject(new Error('Gagal menghubungi Apps Script.'));
    };

    document.body.appendChild(script);
  });
}

async function loadSchedules() {
  try {
    saveConfig();

    const response = await jsonp({
      publicAction: 'schedules',
      scanToken: value('scanToken')
    });

    if (!response.success) throw new Error(response.message || response.code);

    const select = document.getElementById('scheduleId');
    select.innerHTML = response.data.map(row => {
      const label = `${row.Hari || ''} ${row.JamMulai || ''}-${row.JamSelesai || ''} | ${row.ClassID || ''} | ${row.SubjectID || ''}`;
      return `<option value="${escapeAttr(row.ScheduleID)}">${escapeHtml(label)}</option>`;
    }).join('');

    showResult('success', 'Jadwal dimuat', `${response.data.length} jadwal tersedia.`);
  } catch (err) {
    showResult('error', 'Gagal memuat jadwal', err.message);
  }
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Browser tidak mendukung akses kamera. Gunakan HTTPS atau upload gambar QR.');
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment'
      }
    });

    const video = document.getElementById('video');
    video.srcObject = stream;
    await video.play();

    if ('BarcodeDetector' in window) {
      detector = new BarcodeDetector({ formats: ['qr_code'] });
      timer = setInterval(scanWithBarcodeDetector, 600);
    } else {
      if (!window.jsQR) throw new Error('Library jsQR belum termuat.');
      timer = setInterval(scanWithJsQr, 600);
    }

    showResult('success', 'Kamera aktif', 'Arahkan kamera ke QR siswa.');
  } catch (err) {
    showResult('error', 'Kamera gagal dibuka', cameraErrorMessage(err));
  }
}

async function scanWithBarcodeDetector() {
  const video = document.getElementById('video');
  const codes = await detector.detect(video);
  if (codes.length) finishScan(codes[0].rawValue);
}

function scanWithJsQr() {
  const video = document.getElementById('video');
  if (!video.videoWidth || !video.videoHeight) return;

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(image.data, image.width, image.height);

  if (code && code.data) finishScan(code.data);
}

function stopCamera() {
  if (timer) clearInterval(timer);
  if (stream) stream.getTracks().forEach(track => track.stop());

  timer = null;
  stream = null;
  detector = null;
}

function finishScan(rawValue) {
  document.getElementById('qrPayload').value = rawValue;
  stopCamera();
  sendScan(rawValue);
}

function decodeImageQr() {
  const file = document.getElementById('qrImage').files[0];
  if (!file) return;

  const image = new Image();

  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(data.data, data.width, data.height);

    URL.revokeObjectURL(image.src);

    if (code && code.data) {
      document.getElementById('qrPayload').value = code.data;
      sendScan(code.data);
    } else {
      showResult('error', 'QR tidak terbaca', 'Gunakan gambar yang lebih jelas.');
    }
  };

  image.onerror = () => showResult('error', 'Gagal membaca gambar', 'File gambar tidak valid.');
  image.src = URL.createObjectURL(file);
}

function submitManualPayload() {
  const payload = value('qrPayload');
  if (!payload) {
    showResult('error', 'Payload kosong', 'Scan QR, upload gambar QR, atau tempel payload QR terlebih dahulu.');
    return;
  }
  sendScan(payload);
}

async function sendScan(qrPayload) {
  try {
    saveConfig();

    const response = await jsonp({
      publicAction: 'scanQr',
      scanToken: value('scanToken'),
      scheduleId: value('scheduleId'),
      qrPayload,
      deviceId
    });

    if (response.success) {
      const data = response.data;
      showResult(
        'success',
        'Absensi Berhasil',
        `${data.Nama || data.StudentID} tercatat ${data.Status} pukul ${data.Time}.`
      );
      return;
    }

    if (response.code === 'DUPLICATE_ATTENDANCE') {
      const data = response.data || {};
      showResult(
        'warning',
        'Siswa Sudah Absen',
        `${data.Nama || data.StudentID || 'Siswa'} sudah tercatat. Scan pertama: ${data.FirstScan || data.Time || '-'}`
      );
      return;
    }

    showResult('error', response.code || 'ERROR', response.message || 'Absensi gagal.');
  } catch (err) {
    showResult('error', 'Gagal menyimpan absensi', err.message);
  }
}

function cameraErrorMessage(err) {
  const name = err && err.name ? err.name : '';
  const message = err && err.message ? err.message : '';

  if (name === 'NotAllowedError' || /permission/i.test(message)) {
    return 'Permission denied. Izinkan kamera untuk situs GitHub Pages ini, lalu refresh.';
  }

  if (name === 'NotFoundError') {
    return 'Kamera tidak ditemukan. Gunakan upload gambar QR.';
  }

  if (name === 'NotReadableError') {
    return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi kamera/meeting lalu coba lagi.';
  }

  return message || 'Kamera gagal dibuka.';
}

function showResult(type, title, message) {
  const el = document.getElementById('result');
  el.className = `result ${type}`;
  el.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`;
  el.classList.remove('hidden');
}

function value(id) {
  return (document.getElementById(id).value || '').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[s]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}