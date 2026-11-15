/** Emblem cropper: circular preview with zoom (slider or wheel) and
 *  drag-to-pan; OK renders the framed square to a 512px PNG blob. Pure UI
 *  component — no knowledge of vaults or upload targets.
 *
 *  @returns {Promise<Blob|null>} the cropped image, or null on cancel. */

const $ = (sel) => document.querySelector(sel);
const OUT_SIZE = 512;

export function openImageCropper(file) {
  return new Promise((resolve) => {
    const modal = $("#cropper");
    const preview = $("#cropper-canvas");
    const slider = $("#cropper-zoom");
    const ctx = preview.getContext("2d");
    const url = URL.createObjectURL(file);
    const img = new Image();

    // view state: zoom is a factor on top of the circle-cover scale.
    // 1 = circle fully covered; minZoom() = the WHOLE image fits (contain) —
    // the gaps are filled by stretching the image's edge pixels.
    let zoom = 1;
    let offX = 0;
    let offY = 0;

    const size = preview.width; // square canvas, circle inset
    const coverScale = () => size / Math.min(img.naturalWidth, img.naturalHeight);
    const minZoom = () => Math.min(img.naturalWidth, img.naturalHeight) / Math.max(img.naturalWidth, img.naturalHeight);

    /** keep the circle fully covered — clamp pan to the image's edges */
    function clampOffsets() {
      const s = coverScale() * zoom;
      const maxX = Math.max((img.naturalWidth * s - size) / 2, 0);
      const maxY = Math.max((img.naturalHeight * s - size) / 2, 0);
      offX = Math.min(Math.max(offX, -maxX), maxX);
      offY = Math.min(Math.max(offY, -maxY), maxY);
    }

    function drawTo(c, target, dim) {
      const s = (dim / size) * coverScale() * zoom;
      const drawW = target.naturalWidth * s;
      const drawH = target.naturalHeight * s;
      const ix = dim / 2 - drawW / 2 + (offX * dim) / size;
      const iy = dim / 2 - drawH / 2 + (offY * dim) / size;
      c.clearRect(0, 0, dim, dim);
      c.save();
      c.beginPath();
      c.arc(dim / 2, dim / 2, dim / 2, 0, Math.PI * 2);
      c.clip();
      // edge extension: when zoomed out past cover, the gaps continue the
      // image's outermost pixel row/column — every point carries the last
      // visible color of its edge instead of a hard cut
      const nw = target.naturalWidth;
      const nh = target.naturalHeight;
      if (iy > 0) c.drawImage(target, 0, 0, nw, 1, ix, 0, drawW, iy + 0.5);
      if (iy + drawH < dim)
        c.drawImage(target, 0, nh - 1, nw, 1, ix, iy + drawH - 0.5, drawW, dim - (iy + drawH) + 0.5);
      if (ix > 0) c.drawImage(target, 0, 0, 1, nh, 0, iy, ix + 0.5, drawH);
      if (ix + drawW < dim)
        c.drawImage(target, nw - 1, 0, 1, nh, ix + drawW - 0.5, iy, dim - (ix + drawW) + 0.5, drawH);
      c.drawImage(target, ix, iy, drawW, drawH);
      c.restore();
    }

    const render = () => {
      clampOffsets();
      drawTo(ctx, img, size);
    };

    function onKey(ev) {
      if (ev.key === "Escape") close(null);
    }
    function onBackdrop(ev) {
      if (ev.target === modal) close(null); // click outside the box = cancel
    }

    function close(result) {
      modal.hidden = true;
      URL.revokeObjectURL(url);
      document.removeEventListener("keydown", onKey);
      modal.removeEventListener("pointerdown", onBackdrop);
      slider.oninput = null;
      preview.onpointerdown = null;
      preview.onpointermove = null;
      preview.onpointerup = null;
      preview.onwheel = null;
      $("#cropper-ok").onclick = null;
      $("#cropper-cancel").onclick = null;
      resolve(result);
    }

    img.onload = () => {
      modal.hidden = false;
      document.addEventListener("keydown", onKey);
      modal.addEventListener("pointerdown", onBackdrop);
      zoom = 1;
      offX = 0;
      offY = 0;
      slider.min = String(minZoom());
      slider.value = "1";
      render();

      slider.oninput = () => {
        zoom = Number(slider.value);
        render();
      };
      preview.onwheel = (ev) => {
        ev.preventDefault();
        zoom = Math.min(Math.max(zoom * Math.exp(-ev.deltaY * 0.002), minZoom()), 4);
        slider.value = String(zoom);
        render();
      };
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      preview.onpointerdown = (ev) => {
        dragging = true;
        lastX = ev.clientX;
        lastY = ev.clientY;
        preview.setPointerCapture(ev.pointerId);
      };
      preview.onpointermove = (ev) => {
        if (!dragging) return;
        offX += ev.clientX - lastX;
        offY += ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        render();
      };
      preview.onpointerup = () => (dragging = false);

      $("#cropper-cancel").onclick = () => close(null);
      $("#cropper-ok").onclick = () => {
        const out = document.createElement("canvas");
        out.width = OUT_SIZE;
        out.height = OUT_SIZE;
        drawTo(out.getContext("2d"), img, OUT_SIZE);
        out.toBlob((blob) => close(blob), "image/png");
      };
    };
    img.onerror = () => close(null);
    img.src = url;
  });
}
