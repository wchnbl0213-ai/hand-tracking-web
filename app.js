// 确保在所有 HTML 和库加载完成后才执行代码
window.onload = function() {

    // --- MediaPipe 元素获取 ---
    const videoElement = document.getElementById('webcam');
    const canvasElement = document.getElementById('canvas');
    const canvasCtx = canvasElement.getContext('2d');
    const statusElement = document.getElementById('action-status');

    // --- MediaPipe 配置参数 ---
    const FIST_THRESHOLD = 0.15;    // 握拳距离阈值 (指尖到掌根)
    const OPEN_HAND_THRESHOLD = 0.3; // 张开手掌距离阈值 (指尖到手腕)
    const COOLDOWN_TIME = 800;      // 冷却时间 (毫秒)，防止误触

    let isFisted = false;   // 握拳状态锁
    let isOpenHand = false; // 张开手掌状态锁
    let isCooldown = false; // 冷却状态锁
    
    // --- MediaPipe 跟踪变量 ---
    let lastHandX = null;
    let lastHandY = null;
    // 增加晃动幅度: 提高手势灵敏度
    const rotationSpeedFactor = 0.1; // NEW: 提高到 0.1
    
    // 惯性旋转相关变量
    let rotationVelocityX = 0; 
    let rotationVelocityY = 0; 
    // 增加晃动幅度: 提高摩擦力(衰减更慢)
    const friction = 0.96;      // NEW: 提高到 0.96
    // 增加晃动幅度: 提高最大速度
    const maxRotationVelocity = 0.1; // NEW: 提高到 0.1

    // --- Three.js 变量 ---
    let camera, scene, renderer; 
    let particles = [];
    let linesMesh; // 用于存放所有连接线的 LineSegments 对象
    
    const particleCount = 200;
    const particleRadius = 0.3; 
    const connectionDistance = 8; 
    const sphereRadius = 20; // 扩散时的球形结构半径
    const contractRadius = 5; // 收缩时的球形结构半径，保持缝隙
    const smoothFactor = 0.08; // Lerp 平滑因子

    let isContracted = false; 
    
    // 性能优化: 预分配最大线条数量
    const maxLines = particleCount * (particleCount - 1) / 2;
    const maxVertices = maxLines * 2 * 3; 
    let positions = new Float32Array(maxVertices);
    let lineColors = new Float32Array(maxVertices);
    let lineSegmentsGeometry;
    
    // 粒子和连线的颜色常量
    const particleColor = new THREE.Color(0x0000FF); // 蓝色粒子
    const lineColor = new THREE.Color(0x00FF00);   // 绿色连线
    const baseColor = lineColor; // 将baseColor指向新的绿色连线颜色

    // --- 初始化 Three.js 场景 ---
    function initThreeJS() {
        const threeContainer = document.getElementById('three-container');

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.z = 50; 

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setClearColor(0x000000, 1);
        threeContainer.appendChild(renderer.domElement);
        
        // 1. 创建粒子 (原子)
        const particleGeometry = new THREE.SphereGeometry(particleRadius, 16, 16); 
        const particleMaterial = new THREE.MeshBasicMaterial({ color: particleColor }); // 使用蓝色粒子颜色
        
        for (let i = 0; i < particleCount; i++) {
            const particle = new THREE.Mesh(particleGeometry, particleMaterial);
            
            // --- 黄金角度螺旋算法 ---
            const phi = Math.acos(1 - 2 * i / particleCount); 
            const theta = Math.PI * (1 + Math.sqrt(5)) * i;    
            
            // 扩散位置 (originalPosition)
            const diffuseX = sphereRadius * Math.cos(theta) * Math.sin(phi);
            const diffuseY = sphereRadius * Math.sin(theta) * Math.sin(phi);
            const diffuseZ = sphereRadius * Math.cos(phi);
            
            // 收缩位置 (contractPosition)
            const contractX = contractRadius * Math.cos(theta) * Math.sin(phi);
            const contractY = contractRadius * Math.sin(theta) * Math.sin(phi);
            const contractZ = contractRadius * Math.cos(phi);
            
            particle.position.set(diffuseX, diffuseY, diffuseZ);
            
            scene.add(particle);
            particles.push(particle);
            
            // 存储初始位置 (用于扩散)
            particle.userData.originalPosition = particle.position.clone();
            // 存储收缩位置
            particle.userData.contractPosition = new THREE.Vector3(contractX, contractY, contractZ);
            
            particle.userData.targetPosition = particle.position.clone(); // 初始目标为扩散位置
        }

        // 2. 创建高性能 LineSegments
        lineSegmentsGeometry = new THREE.BufferGeometry();
        lineSegmentsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        lineSegmentsGeometry.setAttribute('color', new THREE.BufferAttribute(lineColors, 3).setUsage(THREE.DynamicDrawUsage));
        lineSegmentsGeometry.setDrawRange(0, 0); 
        
        const lineMaterial = new THREE.LineBasicMaterial({ 
            vertexColors: true, 
            blending: THREE.AdditiveBlending, 
            transparent: true, 
            opacity: 0.3
        });

        linesMesh = new THREE.LineSegments(lineSegmentsGeometry, lineMaterial);
        scene.add(linesMesh);
        
        window.addEventListener('resize', onWindowResize, false);
    }
    
    // 窗口大小调整处理
    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // --- 核心优化函数：仅更新 LineSegments 的顶点数据 ---
    function updateLinesPerformance() {
        let lineIndex = 0;
        let lineCount = 0;

        // 遍历所有粒子对，更新 positions 数组
        for (let i = 0; i < particleCount; i++) {
            const p1 = particles[i].position;

            for (let j = i + 1; j < particleCount; j++) {
                const p2 = particles[j].position;
                
                // 计算两粒子间距离（使用 squaredDistance 性能更高）
                const dx = p1.x - p2.x;
                const dy = p1.y - p2.y;
                const dz = p1.z - p2.z;
                const distSq = dx * dx + dy * dy + dz * dz;

                if (distSq < connectionDistance * connectionDistance) {
                    
                    // 顶点 1 (3个分量)
                    positions[lineIndex++] = p1.x;
                    positions[lineIndex++] = p1.y;
                    positions[lineIndex++] = p1.z;
                    
                    // 顶点 2 (3个分量)
                    positions[lineIndex++] = p2.x;
                    positions[lineIndex++] = p2.y;
                    positions[lineIndex++] = p2.z;
                    
                    // 线的颜色: 越近越亮 
                    const normalizedDist = Math.sqrt(distSq) / connectionDistance;
                    const opacity = 1.0 - normalizedDist;
                    
                    // 颜色 1
                    lineColors[lineCount++] = baseColor.r * opacity;
                    lineColors[lineCount++] = baseColor.g * opacity;
                    lineColors[lineCount++] = baseColor.b * opacity;

                    // 颜色 2
                    lineColors[lineCount++] = baseColor.r * opacity;
                    lineColors[lineCount++] = baseColor.g * opacity;
                    lineColors[lineCount++] = baseColor.b * opacity;
                }
            }
        }
        
        // 告诉 Three.js 几何体和颜色数据已更改
        lineSegmentsGeometry.attributes.position.needsUpdate = true;
        lineSegmentsGeometry.attributes.color.needsUpdate = true;
        
        // 更新实际需要绘制的顶点数量
        lineSegmentsGeometry.setDrawRange(0, lineIndex / 3); 
    }

    // 动画循环
    function animate() {
        requestAnimationFrame(animate);

        // --- 粒子平滑移动 (Lerp) ---
        particles.forEach(p => {
            p.position.lerp(p.userData.targetPosition, smoothFactor); 
        });

        // --- 核心优化调用 ---
        updateLinesPerformance();
        
        // --- 场景惯性旋转 ---
        scene.rotation.y += rotationVelocityY;
        scene.rotation.x += rotationVelocityX;

        // 应用摩擦力/衰减
        rotationVelocityY *= friction;
        rotationVelocityX *= friction;
        // -----------------------------------
        
        renderer.render(scene, camera);
    }

    // --- MediaPipe 辅助函数：计算两点间距离 (欧几里得距离) ---
    function distance(point1, point2) {
        return Math.sqrt(
            Math.pow(point1.x - point2.x, 2) + 
            Math.pow(point1.y - point2.y, 2)
        );
    }

    /**
     * 判断是否为握拳动作 (Contraction)
     */
    function isFist(landmarks) {
        if (!landmarks || landmarks.length < 21) return false;
        
        const referencePoint = landmarks[9]; 
        const tipIndices = [8, 12, 16, 20]; 
        
        for (const tipIndex of tipIndices) {
            const tipPoint = landmarks[tipIndex];
            const dist = distance(tipPoint, referencePoint); 
            if (dist > FIST_THRESHOLD) return false;
        }
        return true;
    }
    
    /**
     * 判断是否为张开手掌动作 (Diffusion)
     */
    function isHandSpread(landmarks) {
        if (!landmarks || landmarks.length < 21) return false;
        
        const wrist = landmarks[0];
        const tipIndices = [4, 8, 12, 16, 20]; 
        
        for (const tipIndex of tipIndices) {
            const dist = distance(landmarks[tipIndex], wrist);
            if (dist < OPEN_HAND_THRESHOLD) {
                return false; 
            }
        }
        return true;
    }
    
    // --- 3D 场景互动操作：收缩/扩散 ---
    function controlParticles(contract) { 
        if (isCooldown || isContracted === contract) return;

        isCooldown = true; 
        isContracted = contract;
        
        // 设置所有粒子的目标位置
        particles.forEach(p => {
            // 如果收缩，目标是 contractPosition；否则是 originalPosition
            p.userData.targetPosition.copy(
                contract ? p.userData.contractPosition : p.userData.originalPosition
            );
        });
        
        statusElement.textContent = contract ? '👊 已触发：原子网格收缩' : '👐 已触发：原子网格扩散';
        
        setTimeout(() => {
            isCooldown = false;
            updateStatus();
        }, COOLDOWN_TIME);
    }

    // --- 状态更新辅助函数 ---
    function updateStatus() {
        if (!isCooldown) {
            if (isFisted) {
                 statusElement.textContent = '👊 状态：握拳 (准备收缩)';
            } else if (isOpenHand) {
                 statusElement.textContent = '👐 状态：张开手掌 (准备扩散)';
            } else {
                 statusElement.textContent = '🖐️ 状态：等待手势';
            }
        } else {
             statusElement.textContent = '⏳ 冷却中...';
        }
    }

    // --- 核心逻辑：手势检测和操作触发 ---
    function onResults(results) {
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            
            // 默认只跟踪检测到的第一只手
            const landmarks = results.multiHandLandmarks[0];

            // 绘制手部骨架和关键点
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 5 });
            drawLandmarks(canvasCtx, landmarks, { color: '#FF0000', lineWidth: 2 });
            
            // ----------------------------------------------------
            // 跟踪手部运动并累加旋转速度 (惯性)
            // ----------------------------------------------------
            const wrist = landmarks[0]; 
            const currentHandX = wrist.x;
            const currentHandY = wrist.y;

            if (lastHandX !== null) {
                const deltaX = currentHandX - lastHandX;
                const deltaY = currentHandY - lastHandY;
                
                // 将位移累加到旋转速度
                rotationVelocityY += deltaX * rotationSpeedFactor; 
                rotationVelocityX -= deltaY * rotationSpeedFactor; 

                // 限制最大速度
                rotationVelocityY = Math.max(-maxRotationVelocity, Math.min(maxRotationVelocity, rotationVelocityY));
                rotationVelocityX = Math.max(-maxRotationVelocity, Math.min(maxRotationVelocity, rotationVelocityX));
            }

            lastHandX = currentHandX;
            lastHandY = currentHandY;
            // ----------------------------------------------------
            
            
            const fistDetected = isFist(landmarks);
            const handSpreadDetected = isHandSpread(landmarks);
            
            // 优先处理握拳 (收缩)
            if (fistDetected) {
                if (!isFisted) {
                    isFisted = true;
                    controlParticles(true); // 触发收缩
                }
            } else {
                if (isFisted) isFisted = false;
            }
            
            // 其次处理张开手掌 (扩散)，但要避免与握拳同时触发
            if (handSpreadDetected && !fistDetected) {
                if (!isOpenHand) {
                    isOpenHand = true;
                    controlParticles(false); // 触发扩散
                }
            } else {
                if (isOpenHand) isOpenHand = false;
            }
            
            // 更新状态显示
            if (!isCooldown) updateStatus();

        } else {
            // 未检测到手时，重置跟踪变量
            lastHandX = null; 
            lastHandY = null;
            
             if (!isCooldown) {
                statusElement.textContent = '❌ 状态：未检测到手';
             } else {
                 statusElement.textContent = '⏳ 冷却中...';
             }
        }

        canvasCtx.restore();
    }


    // --- 初始化 MediaPipe Hands 模型 ---
    const hands = new Hands({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`;
        }
    });

    hands.setOptions({
        maxNumHands: 1, 
        modelComplexity: 1, 
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7
    });

    hands.onResults(onResults);


    // --- 启动摄像头和视频流 ---
    const mediaPipeCamera = new Camera(videoElement, { 
        onFrame: async () => {
            await hands.send({ image: videoElement });
        },
        width: 640,
        height: 480
    });

    mediaPipeCamera.start()
        .then(() => {
            console.log('Camera started successfully.');
            canvasElement.width = videoElement.videoWidth;
            canvasElement.height = videoElement.videoHeight;
            statusElement.textContent = '🖐️ 状态：等待手势';

            // 摄像头启动成功后，初始化并启动 Three.js 动画
            initThreeJS();
            animate();

        })
        .catch(error => {
            console.error('Error starting camera:', error);
            if (error.name === 'NotAllowedError') {
                 statusElement.textContent = '❌ 错误：请允许浏览器使用摄像头。';
            } else if (error.name === 'NotReadableError') {
                 statusElement.textContent = '❌ 错误：摄像头被占用或未连接。';
            } else if (error.name === 'SecurityError') {
                 statusElement.textContent = '❌ 错误：请通过本地服务器 (http://localhost) 运行页面。';
            } else {
                 statusElement.textContent = `❌ 错误：无法启动摄像头。(${error.name})`;
            }
        });

}; // <--- window.onload 结束