// Package fileid identifies a filesystem object by the kernel's device and
// inode pair (unix st_dev/st_ino; Windows VolumeSerialNumber and nFileIndex).
package fileid

// Identity is a (device, inode) pair from the kernel file-identity APIs.
type Identity struct {
	Device, Inode uint64
}
