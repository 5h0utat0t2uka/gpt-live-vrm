"use client";

import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useEffect, useRef, useState } from "react";
import {
  Box3,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  ShaderMaterial,
  Spherical,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { AvatarBlink } from "../lib/avatar-blink.ts";
import styles from "./voice-avatar.module.css";

const BREATH_SECONDS = 4.8;
const BREATH_CHEST_DEGREES = 0.9;
const BREATH_SHOULDER_DEGREES = 0.85;
const CLICK_MOVE_PX = 6;
const SMILE_RISE_SECONDS = 0.2;
const SMILE_HOLD_SECONDS = 1;
const SMILE_FADE_SECONDS = 0.48;
const SMILE_STRENGTH = 0.18;

function disposeModel(root: Object3D) {
  const images = new Set<ImageBitmap>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const values = Object.values(material);
      if (material instanceof ShaderMaterial)
        values.push(...Object.values(material.uniforms).map((uniform) => uniform.value));
      for (const value of values) {
        if (value instanceof Texture && typeof ImageBitmap !== "undefined" && value.image instanceof ImageBitmap)
          images.add(value.image);
      }
    }
  });
  VRMUtils.deepDispose(root);
  for (const image of images) image.close();
}

export default function VoiceAvatar({ getLevel }: { getLevel: () => number }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("アバターを読み込んでいます。");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly restarts a failed renderer/load on retry.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const abort = new AbortController();
    let disposed = false;
    let renderer: WebGLRenderer | undefined;
    let vrm: VRM | undefined;
    let resize: ResizeObserver | undefined;
    let controls: OrbitControls | undefined;
    let dragging = false;
    const heldKeys = new Set<string>();
    let returning: { elapsed: number; azimuth: number; polar: number } | undefined;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const blink = new AvatarBlink();
    const scene = new Scene();
    const camera = new PerspectiveCamera(30, 1, 0.01, 100);
    let mouth = 0;
    let lastFrame = 0;
    let smile = 0;
    let smileElapsed = Number.POSITIVE_INFINITY;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const headMeshes = new Set<Mesh>();
    const activePointers = new Set<number>();
    let clickStart: { id: number; x: number; y: number } | undefined;

    function hitsHead(event: PointerEvent) {
      if (!renderer || !vrm) return false;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      );
      raycaster.setFromCamera(pointer, camera);
      // Check the nearest visible mesh, so a click cannot pass through the body to the head.
      const hit = raycaster.intersectObject(vrm.scene, true)[0];
      return !!hit && hit.object instanceof Mesh && headMeshes.has(hit.object);
    }

    function triggerSmile() {
      if (vrm) smileElapsed = 0;
    }

    function pointerDown(event: PointerEvent) {
      activePointers.add(event.pointerId);
      clickStart = undefined;
      if (activePointers.size === 1 && event.isPrimary && event.button === 0 && hitsHead(event)) {
        clickStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
      }
    }

    function pointerMove(event: PointerEvent) {
      if (
        clickStart?.id === event.pointerId &&
        Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y) > CLICK_MOVE_PX
      )
        clickStart = undefined;
    }

    function pointerUp(event: PointerEvent) {
      pointerMove(event);
      if (clickStart?.id === event.pointerId && activePointers.size === 1 && hitsHead(event)) triggerSmile();
      activePointers.delete(event.pointerId);
      clickStart = undefined;
    }

    function pointerCancel(event: PointerEvent) {
      activePointers.delete(event.pointerId);
      clickStart = undefined;
    }

    function release() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      resize?.disconnect();
      controls?.removeEventListener("start", startDrag);
      controls?.removeEventListener("end", returnToFront);
      controls?.dispose();
      renderer?.setAnimationLoop(null);
      renderer?.domElement.removeEventListener("keydown", keyDown);
      renderer?.domElement.removeEventListener("keyup", keyUp);
      renderer?.domElement.removeEventListener("blur", releaseKeys);
      window.removeEventListener("blur", cancelInteraction);
      document.removeEventListener("visibilitychange", visibilityChanged);
      renderer?.domElement.removeEventListener("webglcontextlost", contextLost);
      if (vrm) {
        disposeModel(vrm.scene);
      }
      renderer?.dispose();
      if (renderer && !renderer.getContext().isContextLost()) renderer.forceContextLoss();
      renderer?.domElement.remove();
    }

    function contextLost(event: Event) {
      event.preventDefault();
      release();
      setFailed(true);
      setStatus("アバターの描画が停止しました。音声会話は続けられます。");
    }

    function startDrag() {
      dragging = true;
      returning = undefined;
    }

    function returnToFront() {
      dragging = false;
      if (!controls || heldKeys.size) return;
      if (reducedMotion.matches) {
        controls.reset();
        returning = undefined;
        return;
      }
      returning = { elapsed: 0, azimuth: controls.getAzimuthalAngle(), polar: controls.getPolarAngle() };
    }

    function releaseKeys() {
      heldKeys.clear();
      if (!dragging) returnToFront();
    }

    function keyUp(event: KeyboardEvent) {
      if (heldKeys.delete(event.key) && !heldKeys.size && !dragging) returnToFront();
    }

    function cancelInteraction() {
      activePointers.clear();
      clickStart = undefined;
      // A lost window focus may swallow pointerup/keyup. Clear the control's pointers too.
      if (!controls || !renderer) return;
      controls.disconnect();
      controls.connect(renderer.domElement);
      renderer.domElement.style.touchAction = "pinch-zoom";
      heldKeys.clear();
      returnToFront();
    }

    function visibilityChanged() {
      if (document.hidden) cancelInteraction();
    }

    function keyDown(event: KeyboardEvent) {
      if (!controls || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key.startsWith("Arrow")) {
        returning = undefined;
        heldKeys.add(event.key);
      }
      const step = MathUtils.degToRad(5);
      switch (event.key) {
        case "Enter":
        case " ":
          if (!event.repeat) triggerSmile();
          break;
        case "ArrowLeft":
          controls.rotateLeft(step);
          break;
        case "ArrowRight":
          controls.rotateLeft(-step);
          break;
        case "ArrowUp":
          controls.rotateUp(step);
          break;
        case "ArrowDown":
          controls.rotateUp(-step);
          break;
        case "Home":
          returning = undefined;
          controls.reset();
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    async function load() {
      setFailed(false);
      setStatus("アバターを読み込んでいます。");
      try {
        renderer = new WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.domElement.tabIndex = 0;
        renderer.domElement.setAttribute("role", "button");
        renderer.domElement.setAttribute(
          "aria-label",
          "会話アバター。頭や顔をクリック、またはEnter・Spaceキーで笑顔になります。ドラッグまたは矢印キーで上下左右25度まで回転。離すと正面に戻ります。Homeキーでも正面に戻します。",
        );
        renderer.domElement.setAttribute(
          "aria-keyshortcuts",
          "Enter Space ArrowLeft ArrowRight ArrowUp ArrowDown Home",
        );
        // Register before OrbitControls, so the hit test uses the view before returning to the front.
        renderer.domElement.addEventListener("pointerdown", pointerDown, { signal: abort.signal });
        renderer.domElement.addEventListener("pointermove", pointerMove, { signal: abort.signal });
        renderer.domElement.addEventListener("pointerup", pointerUp, { signal: abort.signal });
        renderer.domElement.addEventListener("pointercancel", pointerCancel, { signal: abort.signal });
        renderer.domElement.addEventListener("lostpointercapture", pointerCancel, { signal: abort.signal });
        renderer.domElement.addEventListener("keydown", keyDown);
        renderer.domElement.addEventListener("keyup", keyUp);
        renderer.domElement.addEventListener("blur", releaseKeys);
        window.addEventListener("blur", cancelInteraction);
        document.addEventListener("visibilitychange", visibilityChanged);
        renderer.domElement.addEventListener("webglcontextlost", contextLost);
        element?.append(renderer.domElement);
        scene.add(new HemisphereLight(0xffffff, 0x777788, 2));
        const light = new DirectionalLight(0xffffff, 2);
        light.position.set(1, 2, 3);
        scene.add(light);
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const response = await fetch("/models/avatar.vrm", { signal: abort.signal, credentials: "same-origin" });
        if (!response.ok) throw new Error("model");
        const gltf = await loader.parseAsync(await response.arrayBuffer(), "/models/");
        if (disposed) {
          disposeModel(gltf.scene);
          return;
        }
        vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          disposeModel(gltf.scene);
          throw new Error("VRM missing");
        }
        VRMUtils.rotateVRM0(vrm);
        VRMUtils.combineSkeletons(vrm.scene);
        vrm.scene.traverse((object) => {
          object.frustumCulled = false;
        });
        scene.add(vrm.scene);
        // These are the face and hair roots in this project's VRoid model, including all material primitives.
        for (const name of ["Face", "Hair"]) {
          vrm.scene.getObjectByName(name)?.traverse((object) => {
            if (object instanceof Mesh) headMeshes.add(object);
          });
        }
        // Keep the upper arms close to the body without restarting a motion loop.
        const leftArm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
        const rightArm = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
        if (leftArm) leftArm.rotation.z = -MathUtils.degToRad(78);
        if (rightArm) rightArm.rotation.z = MathUtils.degToRad(78);
        vrm.update(0);
        const chestBone = vrm.humanoid.getNormalizedBoneNode("chest") ?? vrm.humanoid.getNormalizedBoneNode("spine");
        const leftShoulder = vrm.humanoid.getNormalizedBoneNode("leftShoulder");
        const rightShoulder = vrm.humanoid.getNormalizedBoneNode("rightShoulder");
        const chestRest = chestBone?.rotation.x ?? 0;
        const leftShoulderRest = leftShoulder?.rotation.z ?? 0;
        const rightShoulderRest = rightShoulder?.rotation.z ?? 0;
        let breathTime = 0;
        const bounds = new Box3().setFromObject(vrm.scene);
        const chest = vrm.humanoid.getNormalizedBoneNode("chest")?.getWorldPosition(new Vector3());
        const height = bounds.max.y - bounds.min.y;
        const top = bounds.max.y + height * 0.025;
        const bottom = (chest?.y ?? bounds.max.y - height * 0.25) - height * 0.07;
        const target = new Vector3(chest?.x ?? bounds.getCenter(new Vector3()).x, (top + bottom) / 2, 0);
        const frameHeight = top - bottom;
        const updateSize = () => {
          if (!element || !renderer || disposed) return;
          const { width, height: viewHeight } = element.getBoundingClientRect();
          if (!width || !viewHeight) return;
          camera.aspect = width / viewHeight;
          // Keep the selected angle on resize, and the face large on portrait screens.
          const distance =
            bounds.max.z +
            (Math.max(frameHeight, (height * 0.18) / camera.aspect) / (2 * Math.tan(Math.PI / 12))) * 0.73;
          camera.position
            .setFromSpherical(
              new Spherical(distance, controls?.getPolarAngle() ?? Math.PI / 2, controls?.getAzimuthalAngle() ?? 0),
            )
            .add(target);
          camera.lookAt(target);
          camera.updateProjectionMatrix();
          if (controls) {
            controls.position0.set(target.x, target.y, target.z + distance);
            controls.update();
          }
          renderer.setSize(width, viewHeight);
        };
        resize = new ResizeObserver(updateSize);
        resize.observe(element as HTMLDivElement);
        updateSize();
        controls = new OrbitControls(camera, renderer.domElement);
        controls.target.copy(target);
        controls.enablePan = false;
        controls.enableZoom = false;
        controls.enableDamping = false;
        controls.rotateSpeed = 0.5;
        controls.cursorStyle = "grab";
        const limit = MathUtils.degToRad(25);
        controls.minAzimuthAngle = -limit;
        controls.maxAzimuthAngle = limit;
        controls.minPolarAngle = Math.PI / 2 - limit;
        controls.maxPolarAngle = Math.PI / 2 + limit;
        controls.update();
        controls.saveState();
        controls.addEventListener("start", startDrag);
        controls.addEventListener("end", returnToFront);
        // Keep browser pinch zoom available; the avatar itself only rotates.
        renderer.domElement.style.touchAction = "pinch-zoom";
        setStatus("");
        renderer.setAnimationLoop((time) => {
          if (disposed || !vrm || !renderer) return;
          if (document.hidden) {
            lastFrame = 0;
            return;
          }
          if (lastFrame && time - lastFrame < 1000 / 30) return;
          const delta = lastFrame ? Math.min((time - lastFrame) / 1000, 0.05) : 0;
          lastFrame = time;
          if (returning && controls) {
            returning.elapsed += delta;
            const progress = reducedMotion.matches ? 1 : Math.min(returning.elapsed / 0.35, 1);
            const remaining = (1 - progress) ** 3;
            camera.position
              .setFromSpherical(
                new Spherical(
                  controls.getDistance(),
                  Math.PI / 2 + (returning.polar - Math.PI / 2) * remaining,
                  returning.azimuth * remaining,
                ),
              )
              .add(controls.target);
            if (progress === 1) returning = undefined;
          }
          controls?.update();
          breathTime = reducedMotion.matches ? 0 : (breathTime + delta) % BREATH_SECONDS;
          // Start and end each breath at rest with zero velocity; never accumulate pose offsets.
          const breath = (1 - Math.cos((breathTime / BREATH_SECONDS) * Math.PI * 2)) / 2;
          if (chestBone) chestBone.rotation.x = chestRest - MathUtils.degToRad(BREATH_CHEST_DEGREES) * breath;
          const shoulderLift = MathUtils.degToRad(BREATH_SHOULDER_DEGREES) * breath;
          if (leftShoulder) leftShoulder.rotation.z = leftShoulderRest + shoulderLift;
          if (rightShoulder) rightShoulder.rotation.z = rightShoulderRest - shoulderLift;
          vrm.humanoid.update();
          const level = getLevel();
          // Shut immediately when playback stops; smooth positive levels to avoid jitter.
          mouth = level <= 0 ? 0 : mouth + (level - mouth) * (1 - Math.exp(-delta * 25));
          const smiling = smileElapsed < SMILE_RISE_SECONDS + SMILE_HOLD_SECONDS;
          const smileStep = delta / (smiling ? SMILE_RISE_SECONDS : SMILE_FADE_SECONDS);
          smile = reducedMotion.matches
            ? Number(smiling)
            : MathUtils.clamp(smile + (smiling ? smileStep : -smileStep), 0, 1);
          smileElapsed += delta;
          const happiness = smile * SMILE_STRENGTH;
          // The model's happy morph also opens the mouth and closes the eyes; avoid adding full weights twice.
          vrm.expressionManager?.setValue("happy", happiness);
          vrm.expressionManager?.setValue("aa", mouth * (1 - happiness));
          for (const vowel of ["ih", "ou", "ee", "oh"]) vrm.expressionManager?.setValue(vowel, 0);
          vrm.expressionManager?.setValue("blink", blink.update(delta) * (1 - happiness));
          vrm.expressionManager?.update();
          vrm.nodeConstraintManager?.update();
          renderer.render(scene, camera);
        });
      } catch {
        if (disposed) return;
        release();
        setFailed(true);
        setStatus("アバターを表示できませんでした。音声会話は利用できます。");
      }
    }
    void load();
    return release;
  }, [getLevel, attempt]);

  return (
    <section className={styles.avatar} aria-label="会話アバター">
      <div ref={host} className={styles.stage} hidden={failed} />
      {status && <p role="status">{status}</p>}
      {failed && (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          アバターを再読み込み
        </button>
      )}
    </section>
  );
}
