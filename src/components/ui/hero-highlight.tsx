'use client';
import { cn } from '@/lib/utils';
import {
  useMotionValue,
  motion,
  useMotionTemplate,
  animate,
} from 'motion/react';
import React, { useEffect, useState } from 'react';

export const HeroHighlight = ({
  children,
  className,
  containerClassName,
}: {
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
}) => {
  let mouseX = useMotionValue(0);
  let mouseY = useMotionValue(0);
  const [isHoverable, setIsHoverable] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: fine)');
    setIsHoverable(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsHoverable(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  useEffect(() => {
    if (!isHoverable) {
      const updatePosition = () => {
        const randomX = Math.random() * window.innerWidth;
        const randomY = Math.random() * window.innerHeight;
        animate(mouseX, randomX, { duration: 2 });
        animate(mouseY, randomY, { duration: 2 });
      };

      const interval = setInterval(updatePosition, 2000);
      updatePosition();

      return () => clearInterval(interval);
    }
  }, [isHoverable, mouseX, mouseY]);

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isHoverable || !event.currentTarget) return;
    const { left, top } = event.currentTarget.getBoundingClientRect();
    mouseX.set(event.clientX - left);
    mouseY.set(event.clientY - top);
  };

  return (
    <div
      className={cn(
        'relative h-[40rem] flex items-center bg-[var(--night)] justify-center w-full group',
        containerClassName
      )}
      onMouseMove={handleMouseMove}
    >
      <div className="absolute inset-0 bg-dot-thick-neutral-800 pointer-events-none" />
      <motion.div
        className="pointer-events-none bg-dot-thick-gray-100 absolute inset-0 opacity-0 transition duration-300 group-hover:opacity-100"
        style={{
          WebkitMaskImage: useMotionTemplate`
            radial-gradient(
              200px circle at ${mouseX}px ${mouseY}px,
              black 0%,
              transparent 100%
            )
          `,
          maskImage: useMotionTemplate`
            radial-gradient(
              200px circle at ${mouseX}px ${mouseY}px,
              black 0%,
              transparent 100%
            )
          `,
        }}
      />

      <div className={cn('relative z-20', className)}>{children}</div>
    </div>
  );
};

export const Highlight = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <motion.span
      initial={{
        backgroundSize: '0% 100%',
      }}
      animate={{
        backgroundSize: '100% 100%',
      }}
      transition={{
        duration: 2,
        ease: 'linear',
        delay: 0.5,
      }}
      style={{
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'left center',
        display: 'inline',
      }}
      className={cn(
        `relative inline-block pb-1 px-1 rounded-lg bg-gradient-to-r from-[var(--ash-grey)] to-[var(--timberwolf)]`,
        className
      )}
    >
      {children}
    </motion.span>
  );
};
