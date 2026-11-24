FROM python:3.10-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libgomp1 openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install 'numpy<2' torch==2.4.1+cu124 torchvision==0.19.1+cu124 --extra-index-url https://download.pytorch.org/whl/cu124
RUN pip install 'https://github.com/nerfstudio-project/gsplat/releases/download/v1.5.3/gsplat-1.5.3%2Bpt24cu124-cp310-cp310-linux_x86_64.whl' 'av==16.1.0'
WORKDIR /app
COPY vendor-sharp /app/vendor-sharp
RUN pip install /app/vendor-sharp && python -c "import torch, av; import gsplat.csrc; assert torch.version.cuda == '12.4'; assert 'h264_nvenc' in av.codecs_available"
RUN pip install opencv-python-headless==4.12.0.88
COPY scripts /app/scripts
RUN ln -s /app/scripts/reconstruct.py /app/reconstruct.py
COPY docs/vendor/meshopt-encoder.js docs/vendor/LICENSE-meshoptimizer /app/docs/vendor/
COPY docs/volume-loader.js docs/volume-material.js docs/volume-worker.js /app/docs/
COPY viewer/dist /app/viewer/dist
COPY docs/first-ride/walk.glb /app/example/walks/9392fb9756ab99f070a59497090b4ada34a697d68d95f23412abd3b7f0c61ef2.glb
RUN ln /app/example/walks/9392fb9756ab99f070a59497090b4ada34a697d68d95f23412abd3b7f0c61ef2.glb /app/example/walks/9d331b8d613a626240b90d66c3cb1a2c96d7f6783abc4316400147ec33dcb04c.glb
COPY docs/walk/photo.webp /app/example/photo.webp
COPY docker/start-album.sh /app/start-album.sh
ENV VR_LOCAL_GPU=1
CMD ["sh", "/app/start-album.sh"]
