// android-icons - the Android app's icons, all taken from the real logo.
//
// The logo is artwork (tools/launcher-logo-512.png): it is only scaled and
// masked here, never redrawn. Re-run only when the logo changes:
//
//	go -C tools run ./android-icons
//
// Writes into android/app/src/main/res/:
//
//	mipmap-*/ic_launcher_foreground.png  the logo inside an adaptive icon's
//	                                     safe zone (66 of 108 dp)
//	drawable-*/ic_stat.png               the status-bar icon: the logo's own
//	                                     silhouette, white (Android paints it)
//	drawable-nodpi/splash.png            the TWA's splash picture
//
// The adaptive icon's background is the PWA's background_color, #1E1F23.
//
// It replaces make-icons.py (Pillow) and gives the same pixels: the scaling
// is Pillow's LANCZOS step by step (premultiplied alpha, 22-bit fixed-point
// weights, a horizontal pass then a vertical one, each clipped to 8 bits) and
// a paste is Pillow's paste-through-its-own-alpha. A PNG whose pixels did not
// change is left as it is, so a re-run leaves git clean (Go's compressor
// writes other bytes than Pillow's for the same pixels).
package main

import (
	"bytes"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"

	"nayive/tools/internal/repo"
)

// densities: the Android density folders and their scale over mdpi.
var densities = []struct {
	name string
	k    float64
}{{"mdpi", 1}, {"hdpi", 1.5}, {"xhdpi", 2}, {"xxhdpi", 3}, {"xxxhdpi", 4}}

func main() {
	flag.Parse()
	root := repo.MustRoot("android-icons")
	res := filepath.Join(root, "android", "app", "src", "main", "res")
	if err := run(filepath.Join(root, "tools", "launcher-logo-512.png"), res); err != nil {
		fmt.Fprintln(os.Stderr, "android-icons:", err)
		os.Exit(1)
	}
	fmt.Println("icons written under", res)
}

func run(logoPath, res string) error {
	logo, err := loadNRGBA(logoPath)
	if err != nil {
		return err
	}
	logo = crop(logo, bbox(logo))

	for _, d := range densities {
		canvas := round(108 * d.k)
		fg := image.NewNRGBA(image.Rect(0, 0, canvas, canvas))
		inner := fit(logo, round(62*d.k))
		paste(fg, inner, (canvas-inner.Rect.Dx())/2, (canvas-inner.Rect.Dy())/2)
		if err := save(fg, res, "mipmap-"+d.name, "ic_launcher_foreground.png"); err != nil {
			return err
		}

		size := round(24 * d.k)
		shape := fit(logo, round(22*d.k))
		white := image.NewNRGBA(shape.Rect)
		for i := 0; i < len(shape.Pix); i += 4 {
			white.Pix[i], white.Pix[i+1], white.Pix[i+2] = 255, 255, 255
			if shape.Pix[i+3] > 110 {
				white.Pix[i+3] = 255
			}
		}
		stat := image.NewNRGBA(image.Rect(0, 0, size, size))
		paste(stat, white, (size-white.Rect.Dx())/2, (size-white.Rect.Dy())/2)
		if err := save(stat, res, "drawable-"+d.name, "ic_stat.png"); err != nil {
			return err
		}
	}
	return save(fit(logo, 288), res, "drawable-nodpi", "splash.png")
}

// round is Python 3's round(): halves go to the even neighbour.
func round(x float64) int { return int(math.RoundToEven(x)) }

func loadNRGBA(path string) (*image.NRGBA, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", path, err)
	}
	if n, ok := img.(*image.NRGBA); ok && n.Rect.Min == (image.Point{}) {
		return n, nil
	}
	b := img.Bounds()
	n := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			n.Set(x, y, color.NRGBAModel.Convert(img.At(b.Min.X+x, b.Min.Y+y)))
		}
	}
	return n, nil
}

// bbox is the smallest rectangle holding every pixel that is not fully
// transparent (Pillow's getbbox).
func bbox(m *image.NRGBA) image.Rectangle {
	w, h := m.Rect.Dx(), m.Rect.Dy()
	r := image.Rectangle{Min: image.Point{w, h}}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if m.Pix[y*m.Stride+x*4+3] != 0 {
				r = r.Union(image.Rect(x, y, x+1, y+1))
			}
		}
	}
	return r
}

func crop(m *image.NRGBA, r image.Rectangle) *image.NRGBA {
	out := image.NewNRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := 0; y < r.Dy(); y++ {
		copy(out.Pix[y*out.Stride:y*out.Stride+r.Dx()*4], m.Pix[(r.Min.Y+y)*m.Stride+r.Min.X*4:])
	}
	return out
}

// fit is img scaled to fit a box x box square, centred on a transparent one.
func fit(img *image.NRGBA, box int) *image.NRGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	k := float64(box) / float64(max(w, h))
	small := resize(img, max(1, round(float64(w)*k)), max(1, round(float64(h)*k)))
	out := image.NewNRGBA(image.Rect(0, 0, box, box))
	paste(out, small, (box-small.Rect.Dx())/2, (box-small.Rect.Dy())/2)
	return out
}

// div255 is Pillow's (v + 128) / 255 in shifts.
func div255(v uint32) uint8 {
	t := v + 128
	return uint8(((t >> 8) + t) >> 8)
}

// paste puts src at (dx, dy) on dst through src's own alpha, every band the
// alpha one included: Pillow's im.paste(src, (dx, dy), src).
func paste(dst, src *image.NRGBA, dx, dy int) {
	for y := 0; y < src.Rect.Dy(); y++ {
		for x := 0; x < src.Rect.Dx(); x++ {
			s := src.Pix[y*src.Stride+x*4:]
			d := dst.Pix[(y+dy)*dst.Stride+(x+dx)*4:]
			a := uint32(s[3])
			for i := 0; i < 4; i++ {
				d[i] = div255(uint32(d[i])*(255-a) + uint32(s[i])*a)
			}
		}
	}
}

// ---- Pillow's LANCZOS resize ------------------------------------------

const precisionBits = 32 - 8 - 2

func sinc(x float64) float64 {
	if x == 0 {
		return 1
	}
	x *= math.Pi
	return math.Sin(x) / x
}

func lanczos(x float64) float64 {
	if -3 <= x && x < 3 {
		return sinc(x) * sinc(x/3)
	}
	return 0
}

// coeffs are the fixed-point weights of every output pixel along one axis:
// out pixel i reads `n[i]` inputs from `first[i]`, weights k[i*ksize:].
type coeffs struct {
	ksize    int
	first, n []int
	k        []int32
}

func precompute(inSize, outSize int) coeffs {
	scale := float64(inSize) / float64(outSize)
	filterscale := max(scale, 1.0)
	support := 3.0 * filterscale
	ksize := int(math.Ceil(support))*2 + 1
	c := coeffs{ksize: ksize, first: make([]int, outSize), n: make([]int, outSize), k: make([]int32, outSize*ksize)}
	pre := make([]float64, ksize)
	for xx := 0; xx < outSize; xx++ {
		center := (float64(xx) + 0.5) * scale
		ss := 1.0 / filterscale
		xmin := int(center - support + 0.5)
		if xmin < 0 {
			xmin = 0
		}
		xmax := int(center + support + 0.5)
		if xmax > inSize {
			xmax = inSize
		}
		xmax -= xmin
		ww := 0.0
		for x := 0; x < xmax; x++ {
			w := lanczos((float64(x+xmin) - center + 0.5) * ss)
			pre[x] = w
			ww += w
		}
		for x := 0; x < xmax; x++ {
			if ww != 0 {
				pre[x] /= ww
			}
			if pre[x] < 0 {
				c.k[xx*ksize+x] = int32(-0.5 + pre[x]*(1<<precisionBits))
			} else {
				c.k[xx*ksize+x] = int32(0.5 + pre[x]*(1<<precisionBits))
			}
		}
		c.first[xx], c.n[xx] = xmin, xmax
	}
	return c
}

func clip8(v int32) uint8 {
	v >>= precisionBits
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v)
}

// resize is Pillow's im.resize((w, h), LANCZOS) on an RGBA image.
func resize(src *image.NRGBA, w, h int) *image.NRGBA {
	inW, inH := src.Rect.Dx(), src.Rect.Dy()
	if w == inW && h == inH {
		out := image.NewNRGBA(src.Rect)
		copy(out.Pix, src.Pix)
		return out
	}
	// RGBA -> RGBa: colour times alpha.
	cur := image.NewNRGBA(src.Rect)
	for i := 0; i < len(src.Pix); i += 4 {
		a := uint32(src.Pix[i+3])
		for j := 0; j < 3; j++ {
			t := uint32(src.Pix[i+j])*a + 128
			cur.Pix[i+j] = uint8(((t >> 8) + t) >> 8)
		}
		cur.Pix[i+3] = src.Pix[i+3]
	}
	if w != inW {
		c := precompute(inW, w)
		next := image.NewNRGBA(image.Rect(0, 0, w, inH))
		for y := 0; y < inH; y++ {
			row := cur.Pix[y*cur.Stride:]
			for xx := 0; xx < w; xx++ {
				k := c.k[xx*c.ksize:]
				for b := 0; b < 4; b++ {
					ss := int32(1 << (precisionBits - 1))
					for x := 0; x < c.n[xx]; x++ {
						ss += int32(row[(x+c.first[xx])*4+b]) * k[x]
					}
					next.Pix[y*next.Stride+xx*4+b] = clip8(ss)
				}
			}
		}
		cur = next
	}
	if h != inH {
		c := precompute(inH, h)
		next := image.NewNRGBA(image.Rect(0, 0, w, h))
		for yy := 0; yy < h; yy++ {
			k := c.k[yy*c.ksize:]
			for xx := 0; xx < w; xx++ {
				for b := 0; b < 4; b++ {
					ss := int32(1 << (precisionBits - 1))
					for y := 0; y < c.n[yy]; y++ {
						ss += int32(cur.Pix[(y+c.first[yy])*cur.Stride+xx*4+b]) * k[y]
					}
					next.Pix[yy*next.Stride+xx*4+b] = clip8(ss)
				}
			}
		}
		cur = next
	}
	// RGBa -> RGBA: colour over alpha, clipped; alpha 0 and 255 kept as they are.
	for i := 0; i < len(cur.Pix); i += 4 {
		a := uint32(cur.Pix[i+3])
		if a == 0 || a == 255 {
			continue
		}
		for j := 0; j < 3; j++ {
			cur.Pix[i+j] = uint8(min(255, 255*uint32(cur.Pix[i+j])/a))
		}
	}
	return cur
}

// ---- output ----------------------------------------------------------

// save writes img as folder/name under res - unless the PNG there already
// holds exactly these pixels.
func save(img *image.NRGBA, res, folder, name string) error {
	dir := filepath.Join(res, folder)
	path := filepath.Join(dir, name)
	if old, err := loadNRGBA(path); err == nil && old.Rect == img.Rect && bytes.Equal(old.Pix, img.Pix) {
		return nil
	}
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return err
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o666)
}
