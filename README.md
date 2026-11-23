# VR Memories

**Step back into a family photograph.** In *Black Mirror*’s “Eulogy,” a man visits places inside old photographs. That idea stayed with me. I wanted to open my own family album and choose where to stand in a moment I remembered. [The episode](https://www.netflix.com/tudum/articles/black-mirror-eulogy-ending-explained)

**[Visit the bicycle lesson →](https://alexasandrovich.github.io/vr-memories/)** · **[Bring your own photo →](https://alexasandrovich.github.io/vr-memories/try.html)**

[![The camera pulls back from a child and grandfather, revealing the bicycle, the yard and the edges of the reconstructed photograph.](docs/first-ride/preview.webp)](https://alexasandrovich.github.io/vr-memories/)

### The first ride

My grandfather is teaching me to ride. Up close you can see his fingers around the handlebars. Back away and the bicycle, the parked car and the fence separate in depth. Keep going and you can see where the photograph runs out.

Apple SHARP reconstructs one 3D scene from the picture. The film takes a camera through that scene. **Walk here** puts the same scene under your control, starting from the frame you’re watching. Try pausing halfway through the opening pullback, then walk off to one side.

| In the browser | Control |
| --- | --- |
| Move through the scene | WASD, arrow keys or the on-screen pad |
| Turn around or look up and down | Drag to look, or use Q/E to turn left and right |
| Move closer or farther | Scroll, pinch, or hold W/S |
| Find your way back | **Return to original position** |

**Your own photo in the browser.** Choose a JPEG, PNG or WebP and select **Create 3D scene**. A desktop browser with WebGPU builds the scene on your device. Your picture stays in the tab. The first run downloads about 690 MB, including a quantized SHARP browser model. [Open the browser demo](https://alexasandrovich.github.io/vr-memories/try.html) · [Browser model and credits](docs/vendor/sharp-browser/NOTICE.md)

**On a phone or a computer without WebGPU?** Open the community SHARP Space, upload a photo there, then download the .PLY file. Choose **Open the downloaded 3D scene** in our browser demo to walk through it. This option processes the image on Hugging Face. [Create on a cloud GPU ↗](https://huggingface.co/spaces/gagndeep/Apple-Sharp-Image-to-3D-View-Synthesis)

## Run with Docker

From a clone of this repository, start the same web demo locally.

```sh
docker compose up -d --build
```

Open [localhost:7860](http://localhost:7860). You can walk through all three scenes immediately. Creating a scene from your own photo uses your browser’s GPU and downloads the model on first use. Stop the demo with `docker compose down`.

For a private Quest album with full-precision SHARP, GPU reconstruction, and stereo rendering, use the [Linux NVIDIA container](guides/setup.md#quest-album-with-docker). It uses a read-only photo folder and remembers prepared scenes between visits.

## Your album in Quest

1. **Pick a memory.** Point at a thumbnail and pull the trigger. Your GPU reconstructs the photo with Apple SHARP and saves the scene for your next visit.
2. **Move closer.** Lean or use the sticks. The RTX renders a separate view for each eye, and the headset responds to head motion between streamed frames.
3. **Choose the next photo.** Squeeze the grip to return to the album. Your headset connects over Wi-Fi and pairs the headset with a one-time code.

A single photograph captures only the surfaces the camera could see. Nearby viewpoints reveal depth. Larger steps can uncover gaps at foreground edges.

Run the full album on one Linux NVIDIA host with Docker, or use the original Mac and SSH setup. [Setup and controls](guides/setup.md) · [Apple SHARP](https://github.com/apple-aiml-research/ml-sharp) · [Viewer dependencies and licenses](viewer/README.md)

### Research model

This repository includes the SHARP inference [source and notices](vendor-sharp/NOTICE). The [research checkpoint](https://github.com/Alexasandrovich/vr-memories/releases/tag/sharp-2572gikvuh) is distributed with Apple’s model agreement. On the GPU host, `python3.11 scripts/sharp_checkpoint.py` downloads the two parts, reassembles the original weights and verifies their SHA-256. The prebuilt browser demos run without the checkpoint.

Apple Machine Learning Research Model is licensed under the Apple Machine Learning Research Model License Agreement. The grant covers non-commercial scientific research and excludes product development and commercial use. [Full model terms](vendor-sharp/LICENSE_MODEL)
