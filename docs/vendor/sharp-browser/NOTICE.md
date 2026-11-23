# Browser inference

The photo is decoded in the tab. A dedicated worker predicts Gaussians and prepares them for the local WebGL viewer. The browser fetches static model files from Hugging Face. Only the downloadable model is cached for reuse.

The image decoder, weight reader, SHARP inference, scene statistics and PLY writer are adaptations of [SharpRig](https://github.com/sm079/sharp-rig/tree/52fa96792e8e095c2b4a7297cd5dc8ca3c560333) by sm079, used under its [MIT license](LICENSE). This copy uses native JavaScript modules, reports download progress and passes the generated PLY directly to VR Memories. The inference runtime is [ONNX Runtime Web 1.30.0](https://www.npmjs.com/package/onnxruntime-web/v/1.30.0), distributed with its [license](ort/LICENSE) and [third-party notices](ort/ThirdPartyNotices.txt).

The browser downloads the [SharpRig ONNX export and int8-packed weights](https://huggingface.co/sm079/sharp-onnx-webgpu/tree/1edfee8b806dec15daab30ef2c461de454bf5d79). This community derivative uses fp16 inference with weights rounded to int8 and keeps both Gaussian layers. The original full-precision checkpoint powers the self-hosted album and was used for the featured scene.

Apple Machine Learning Research Model is licensed under the Apple Machine Learning Research Model License Agreement. The model is for non-commercial scientific research. [Model agreement](https://github.com/Alexasandrovich/vr-memories/blob/main/vendor-sharp/LICENSE_MODEL) · [Derivative details](https://huggingface.co/sm079/sharp-onnx-webgpu).
