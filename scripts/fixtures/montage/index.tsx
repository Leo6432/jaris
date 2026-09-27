import { Composition, registerRoot } from 'remotion'
import { Video } from './Video'

const Root = () => <Composition id="Video" component={Video} durationInFrames={60} fps={30} width={1920} height={1080} />

registerRoot(Root)
