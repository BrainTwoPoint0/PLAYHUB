"""Jersey reader (Arm B PARSeq) + legibility gate (ResNet34 SoccerNet).

Torch imports live INSIDE functions: the rest of the pipeline (and its
tests) never needs the DL stack. Both checkpoints are plain state dicts and
load with weights_only=True — no pickle execution. Only the Apache-2.0
fine-tune (parseq_armB.pt) ships; never the paper's pickle checkpoint.

Crop convention (probe/eval_str_arms — do not change without re-measuring):
padded crop with MARGIN, torso band rows, PARSeq transform (32, 128),
confidence = product of per-char softmax.
"""
from __future__ import annotations

import os
import sys
from typing import Any

from harvest import MARGIN

B0 = MARGIN / (1 + 2 * MARGIN)
B1 = (1 + MARGIN) / (1 + 2 * MARGIN)
BATCH = 64


def band(im):
    """Torso band inside the padded crop."""
    h = im.shape[0]
    bh = B1 - B0
    y1 = int(round((B1 - 0.42 * bh) * h))
    y0 = int(round((B1 - 0.82 * bh) * h))
    return im[max(0, y0):y1]


class JerseyReader:
    """Loads both models once; reads and scores BGR crops in batches."""

    def __init__(self, parseq_path: str, legibility_path: str,
                 strhub_root: str, device: str = 'cpu',
                 num_threads: int | None = None):
        sys.path.insert(0, os.path.join(strhub_root, 'str', 'parseq'))
        import torch
        import pytorch_lightning.utilities.types as _plt
        for _n in ('EPOCH_OUTPUT', 'STEP_OUTPUT'):
            if not hasattr(_plt, _n):
                setattr(_plt, _n, Any)
        from strhub.data.module import SceneTextDataModule
        from strhub.models.utils import create_model
        from torch import nn
        from torchvision import models, transforms

        if num_threads:
            torch.set_num_threads(num_threads)
        self._torch = torch
        self._device = device
        self._tf = SceneTextDataModule.get_transform((32, 128))

        m = create_model('parseq', pretrained=False, max_label_length=25)
        m.load_state_dict(torch.load(parseq_path, map_location='cpu',
                                     weights_only=True))
        self._parseq = m.eval().to(device)

        class _Leg(nn.Module):
            def __init__(self):
                super().__init__()
                self.model_ft = models.resnet34(weights=None)
                self.model_ft.fc = nn.Linear(
                    self.model_ft.fc.in_features, 1)

            def forward(self, x):
                return torch.nn.functional.sigmoid(self.model_ft(x))

        leg = _Leg()
        leg.load_state_dict(torch.load(legibility_path, map_location='cpu',
                                       weights_only=True))
        self._leg = leg.eval().to(device)
        self._leg_tf = transforms.Compose([
            transforms.Resize((256, 256)),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406],
                                 std=[0.229, 0.224, 0.225]),
        ])

    def read(self, crops: list) -> list:
        """[(text, conf)] for each BGR crop (torso band applied here)."""
        from PIL import Image
        torch = self._torch
        out = []
        with torch.no_grad():
            for i in range(0, len(crops), BATCH):
                x = torch.stack([
                    self._tf(Image.fromarray(band(c)[:, :, ::-1]))
                    for c in crops[i:i + BATCH]])
                p = self._parseq(x.to(self._device)).softmax(-1)
                preds, confs = self._parseq.tokenizer.decode(p)
                out += [(t, float(c.prod().item()) if len(c) else 0.0)
                        for t, c in zip(preds, confs)]
        return out

    def legibility(self, crops: list) -> list:
        """Legibility score [0,1] per WHOLE BGR crop."""
        from PIL import Image
        torch = self._torch
        out = []
        with torch.inference_mode():
            for i in range(0, len(crops), BATCH):
                x = torch.stack([
                    self._leg_tf(Image.fromarray(c[:, :, ::-1]))
                    for c in crops[i:i + BATCH]])
                out.extend(self._leg(x.to(self._device))
                           .cpu().numpy().ravel().tolist())
        return out
