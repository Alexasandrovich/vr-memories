# VR Memories

**My grandfather was teaching me to ride a bike.** In the photograph, his hand is still on the handlebars. Take a step to one side and the blue car shifts behind us.

**[Step into the first ride →](https://alexasandrovich.github.io/vr-memories/)** · **[Try your own photograph →](https://alexasandrovich.github.io/vr-memories/try.html)**

[![A short camera walk through the family photograph. A grandfather steadies the handlebars while a child smiles on a bicycle.](docs/first-ride/preview.webp)](https://alexasandrovich.github.io/vr-memories/)

The 15-second film moves from a wide view of the bicycle down to the handlebars, around to my grandfather’s side and up to our faces. Pick a **Camera angle** and choose **Walk here** to explore it yourself. No headset is needed.

**Your own photo in the browser.** Choose a JPEG, PNG or WebP and select **Create 3D scene**. A desktop browser with WebGPU builds the scene on your device. Your picture stays in the tab. The first run downloads about 690 MB, including a quantized SHARP browser model. [Open the browser demo](https://alexasandrovich.github.io/vr-memories/try.html) · [Browser model and credits](docs/vendor/sharp-browser/NOTICE.md)

## Your album in Quest

1. **Pick a memory.** Point at a thumbnail and pull the trigger. Your GPU reconstructs the photo with Apple SHARP and saves the scene for your next visit.
2. **Move closer.** Lean or use the sticks. The RTX renders a separate view for each eye, and the headset responds to head motion between streamed frames.
3. **Choose the next photo.** Squeeze the grip to return to the album. Your Mac serves it over Wi-Fi and pairs the headset with a one-time code.

A single photograph captures only the surfaces the camera could see. Nearby viewpoints reveal depth. Larger steps can uncover gaps at foreground edges.

The self-hosted album runs on a Mac, an SSH-accessible NVIDIA GPU with CUDA and NVENC, and Quest Browser. [Setup and controls](guides/setup.md) · [Apple SHARP](https://github.com/apple-aiml-research/ml-sharp) · [Viewer dependencies and licenses](viewer/README.md)

### Research model

This repository includes the SHARP inference [source and notices](vendor-sharp/NOTICE). The [research checkpoint](https://github.com/Alexasandrovich/vr-memories/releases/tag/sharp-2572gikvuh) is distributed with Apple’s model agreement. On the GPU host, `python3.11 scripts/sharp_checkpoint.py` downloads the two parts, reassembles the original weights and verifies their SHA-256. The prebuilt browser demos run without the checkpoint.

Apple Machine Learning Research Model is licensed under the Apple Machine Learning Research Model License Agreement. The grant covers non-commercial scientific research and excludes product development and commercial use. [Full model terms](vendor-sharp/LICENSE_MODEL)
